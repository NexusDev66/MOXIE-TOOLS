#!/usr/bin/env node
/**
 * 国产新锐发现 · 魔搭 ModelScope 创空间(官方机构出品的在线 AI 工具)
 *
 * 思路(全公开数据,官方 API,不爬不破解):
 *   1) PUT /api/v1/studios(官方列表接口,SortBy=VisitsCount)按访问量从高到低翻页
 *   2) 只收「官方/认证机构出品(白名单)+ 访问量达阈值 + 有独立访问域名(xxx.ms.show)」的创空间
 *      —— 独立域名保证 domain 唯一键不撞、国内直连;阈值+白名单滤掉个人 Demo/meme
 *   3) 复用 screen(规则闸→AI 清洗中文化)→ 写 moxie_products(status=pending),domestic_available 恒「是」
 * 与海外源(PH/HN/sitemap)互补,补「国内可直连的国产 AI 工具」这一空缺。不改原有流水线格局:
 * 产出的就是普通 pending 行,后续 enrich/promote/rank/prerender/gen-logos 照常处理(ms.show 无 Tranco→traffic_rank 留空,rank 本就兼容)。
 *
 * 跑法:node --env-file=.env.local cli/discover-modelscope.js [--limit 40] [--min-visits 50000] [--pages 3] [--all] [--dry-run]
 *   --all:忽略机构白名单(只按访问量阈值,会带进个人 Demo,慎用)
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */
import { screen } from './screen.mjs';
import { normDomain, uniqueSlug } from './lib.mjs';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOGO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'logos');

// 图片魔数校验(PNG/JPEG/GIF/WEBP/BMP);拒 SVG/HTML
function isImage(b) {
  if (!b || b.length < 16) return false;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                   // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                   // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57) return true;  // WEBP
  if (b[0] === 0x42 && b[1] === 0x4d) return true;                                    // BMP
  return false;
}
async function fetchBuf(url, t = 12000) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', Accept: 'image/*,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(t) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
// 用每个创空间自己的 CoverImage 当 logo(ms.show 共用魔搭 favicon,gen-logos 抓回来全一样 → 必须改用封面)。
// OSS/CDN 原生缩放参数取 200×200 小方图(800KB→~20KB);拿不到原图兜底;再不行留给 gen-logos。已存在则跳过(已提交的正确封面)。
async function saveCover(domain, cover) {
  if (!cover) return false;
  const out = join(LOGO_DIR, `${domain}.png`);
  if (existsSync(out)) return true;
  const sep = cover.includes('?') ? '&' : '?';
  for (const u of [`${cover}${sep}x-oss-process=image/resize,m_fill,w_200,h_200`, cover]) {
    try { const buf = await fetchBuf(u); if (buf.length > 70 && isImage(buf)) { writeFileSync(out, buf); return true; } } catch { /* 下一个 */ }
  }
  return false;
}

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Math.max(1, Number(arg('limit', '40')) || 40);            // 最多入库多少个
const MIN_VISITS = Math.max(0, Number(arg('min-visits', '50000')) || 0); // 访问量阈值
const PAGES = Math.max(1, Number(arg('pages', '3')) || 3);               // 最多翻几页(每页100)
const ALL = process.argv.includes('--all');                              // 忽略机构白名单
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

const API = 'https://modelscope.cn/api/v1/studios';

// 官方/认证机构白名单(小写比对)。出品方在这里才收 —— 滤掉个人 Demo / meme 音声。需要时按需补充。
const ORG_WHITELIST = new Set([
  'iic', 'qwen', 'wan-ai', 'tongyi', 'damo_xr_lab', 'damo', 'wordart', 'kwai-kolors',
  'ai-modelscope', 'modelscope', 'indexteam', 'funaudiollm', 'zhipuai', 'deepseek-ai',
  'baai', 'openbmb', 'opengvlab', 'shanghai_ai_laboratory', 'minimax', 'moonshotai',
  'stepfun', 'baichuan-inc', 'internlm', 'ms-agent',
].map((s) => s.toLowerCase()));

// 名字里有这些字样的跳过(已停用/纯测试/示例)
const NAME_SKIP = /(停止分享|已停止|停用|测试|示例|test\b|demo复制|副本)/i;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

/** 拉一页创空间(按访问量降序) */
async function fetchStudios(page) {
  const res = await fetch(API, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ PageSize: 100, PageNumber: page, SortBy: 'VisitsCount', Target: '', SingleCriterion: [] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`ModelScope ${res.status}`);
  const j = await res.json();
  return (j.Data && j.Data.Studios) || [];
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } }

async function main() {
  console.log(`\n🇨🇳 魔搭创空间发现(国产·官方机构 AI 工具)${DRY_RUN ? ' [DRY-RUN]' : ''} · 访问≥${MIN_VISITS} · 白名单${ALL ? '关' : '开'} · 上限 ${LIMIT}\n`);

  const existing = await sb('/moxie_products?select=domain,slug,status&limit=4000');
  const known = new Set(existing.map((p) => normDomain(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => normDomain(p.domain)));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  if (!DRY_RUN) mkdirSync(LOGO_DIR, { recursive: true });
  const tally = { ok: 0, dup: 0, rejected: 0, noorg: 0, lowvisit: 0, nourl: 0, skip: 0, rule: 0, ai: 0, badcat: 0, fail: 0, logo: 0 };

  for (let page = 1; page <= PAGES && tally.ok < LIMIT; page++) {
    let studios;
    try { studios = await fetchStudios(page); } catch (e) { console.log(`   ⚠ 第 ${page} 页取不到(${e.message})`); break; }
    if (!studios.length) break;

    for (const st of studios) {
      if (tally.ok >= LIMIT) break;
      const visits = st.Visits || 0;
      if (visits < MIN_VISITS) { tally.lowvisit++; continue; }            // 列表按访问量降序,可继续(后面只会更低,但保险起见不 break,跨页阈值边界)
      const orgName = (st.Organization && st.Organization.Name) || '';
      if (!ALL && !ORG_WHITELIST.has(orgName.toLowerCase())) { tally.noorg++; continue; }
      const domain = hostOf(st.IndependentUrl);
      if (!domain) { tally.nourl++; continue; }                          // 无独立域名(挤在 modelscope.cn)→ 撞唯一键,跳过
      const name = (st.ChineseName || st.Name || '').trim().slice(0, 60);
      if (!name || NAME_SKIP.test(name)) { tally.skip++; continue; }
      if (rejected.has(domain)) { tally.rejected++; continue; }
      // 不论新老,先用封面纠正 logo(已上架的也借此把"共用 favicon"换成各自封面)
      if (!DRY_RUN && await saveCover(domain, st.CoverImage)) tally.logo++;
      if (known.has(domain)) { tally.dup++; continue; }

      const og = `${name}。${(st.Description || '').replace(/\s+/g, ' ').trim()}`.slice(0, 400);
      try {
        // trusted:白名单+访问量已是双重把关,属 curated 源 → 跳过规则闸(否则通义千问/万相等旗舰会因缺典型信号被误拒)
        const r = await screen({ name, domain, og, occurrence_count: 0, traffic_rank: null }, cats, { trusted: true });
        if (r.verdict !== 'keep') {
          console.log(`   ✗ ${name} (${domain}) → ${r.stage === 'rule' ? '规则闸' : 'AI'}拒[${r.kind}]`);
          r.stage === 'rule' ? tally.rule++ : tally.ai++; continue;
        }
        const n = r.normalized;
        if (!n.category_slug || !catId[n.category_slug]) { tally.badcat++; continue; }
        if (!n.tagline_zh) { tally.fail++; continue; }
        const slug = uniqueSlug(name, domain, knownSlug);
        const row = {
          slug, name, domain,
          tagline: n.tagline_zh, description: n.description_zh,
          category_id: catId[n.category_slug], tags: n.tags,
          price_label: n.price_label, domestic_available: '是',          // 魔搭托管,国内直连
          data_overseas: false, verified: false, featured: false,
          vote_count: 0, status: 'pending',
        };
        if (DRY_RUN) { console.log(`   ✓[dry] ${name} (${domain}) [${n.category_slug}] ${n.tagline_zh}  ·${orgName}·${visits}访`); tally.ok++; continue; }
        known.add(domain); knownSlug.add(slug);
        await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
        console.log(`   ✓ ${name} (${domain}) [${n.category_slug}] ·${orgName}· → pending`);
        tally.ok++;
      } catch (err) {
        if (/duplicate key|23505|domain_unique/i.test(err.message)) tally.dup++;
        else { console.log(`   · ${name} → 失败(${err.message})`); tally.fail++; }
      }
    }
  }

  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 黑名单 ${tally.rejected} · 非白名单机构 ${tally.noorg} · 访问不足 ${tally.lowvisit} · 无独立域名 ${tally.nourl} · 跳过 ${tally.skip} · 规则拒 ${tally.rule} · AI拒 ${tally.ai} · 难归类 ${tally.badcat} · 失败 ${tally.fail} · 封面logo ${tally.logo}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 pending,等 enrich-detail 补 detail → promote 自动上架。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
