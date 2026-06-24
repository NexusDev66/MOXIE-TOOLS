#!/usr/bin/env node
/**
 * 存量补全 · 强反爬大目录经 Wayback 存档抓取(TAAFT / Toolify)
 *
 * 背景:TAAFT、Toolify 是最大的两个 AI 工具目录,但全站挂 Cloudflare challenge,
 *       免费/机房 IP 直连一律 403,连程序控制的真浏览器都被卡在挑战循环。
 *       **绕法:从 archive.org(Wayback)存档取**——存档服务器不经过它们的 Cloudflare,完全可达。
 * 代价:快照偏旧(多 2024),所以是**存量"补广度"**,不是"今日新品" → 不进 4h 流水线,手动/定期跑。
 *
 * 流程:CDX 列存档工具页 → 取存档原始 HTML(...id_/...)→ og:title(名)/og:description(简介)/
 *       slug 命中或最高频外链(真域名)→ 复用 screen 清洗 → 写 moxie_products(status=pending)。
 *
 * 跑法:node --env-file=.env.local cli/discover-wayback.js [--site taaft|toolify] [--limit 50] [--offset 0] [--cdx 8000] [--dry-run]
 *   --offset:跳过 CDX 前 N 个 slug(CDX 按字母序,多次跑用它推进,避免每次从头重扫已收录的)
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */
import { screen } from './screen.mjs';
import { normDomain, uniqueSlug } from './lib.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const SITE = (arg('site', 'taaft') || 'taaft').toLowerCase();
const LIMIT = Math.max(1, Number(arg('limit', '50')) || 50);
const OFFSET = Math.max(0, Number(arg('offset', '0')) || 0);
const CDX_LIMIT = Math.max(100, Number(arg('cdx', '8000')) || 8000);
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

// 站点配置:cdx=CDX 通配,host=工具页主机,pathRe=从 original 抽干净 slug,clean=从 og:title 取真名
const SITES = {
  taaft: {
    name: 'TAAFT', cdx: 'theresanaiforthat.com/ai/*', host: 'theresanaiforthat.com',
    pathRe: /^https?:\/\/theresanaiforthat\.com\/ai\/([^/?#]+)\/?$/i,
    clean: (t) => t.replace(/\s+And\s+\d+\s+Other.*$/i, '').replace(/\s*-\s*AI Tool For .*$/i, '').replace(/\s*[-|]\s*(There'?s?\s+An?\s+AI\s+For\s+That|TAAFT).*$/i, '').trim(),
  },
  toolify: {
    name: 'Toolify', cdx: 'www.toolify.ai/tool/*', host: 'toolify.ai',
    pathRe: /^https?:\/\/(?:www\.)?toolify\.ai\/tool\/([^/?#]+)\/?$/i,
    clean: (t) => t.replace(/\s*:\s*Reviews,\s*Pricing.*$/i, '').replace(/\s*[-|]\s*Toolify.*$/i, '').trim(),
  },
};
const CFG = SITES[SITE];
if (!CFG) { console.error(`❌ --site 只支持:${Object.keys(SITES).join(' / ')}`); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const SKIP_HOST = /(^|\.)(archive\.org|web\.archive\.org|theresanaiforthat\.com|toolify\.ai|twitter\.com|x\.com|facebook\.com|linkedin\.com|youtube\.com|youtu\.be|instagram\.com|tiktok\.com|github\.com|producthunt\.com|t\.me|discord\.gg|discord\.com|reddit\.com|medium\.com|google\.com|gstatic\.com|googleapis\.com|cloudflare\.com|getrewardful\.com|stripe\.com|tally\.so|gumroad\.com|short\.gy|pxf\.io|sjv\.io|bit\.ly)$/i;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

async function get(url, timeout = 30000, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      if (res.status === 503 || res.status === 429) { await new Promise((r) => setTimeout(r, 2000 * (i + 1))); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (e) { if (i === tries - 1) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw new Error('重试耗尽');
}

/** CDX 列出工具页:返回 [{slug,ts,orig}],每 slug 取最新快照 */
async function cdxSlugs() {
  const url = `https://web.archive.org/cdx/search/cdx?url=${CFG.cdx}&output=text&fl=original,timestamp&filter=statuscode:200&collapse=urlkey&limit=${CDX_LIMIT}`;
  const text = await get(url, 60000, 4);
  const map = new Map();
  for (const line of text.split('\n')) {
    const [orig, ts] = line.trim().split(/\s+/);
    if (!orig) continue;
    const m = orig.match(CFG.pathRe);
    if (!m) continue;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    if (slug === '$' || slug.length < 2) continue;
    const prev = map.get(slug);
    if (!prev || ts > prev.ts) map.set(slug, { ts, orig });
  }
  return [...map.entries()].map(([slug, v]) => ({ slug, ts: v.ts, orig: v.orig }));
}

function pickMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return m ? m[1].trim() : '';
}
function decodeEnt(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'"); }

/** 真域名:优先 slug 命中的外链(避开"竞品/广告"高频链),否则最高频非跳过外链 */
function extractDomain(html, slug) {
  const slugN = slug.replace(/[^a-z0-9]/gi, '');
  const tally = {}; let bySlug = null;
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    let host; try { host = new URL(m[1]).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }
    if (!host || SKIP_HOST.test(host)) continue;
    if (/\.(png|jpe?g|svg|gif|webp|css|js|ico|woff2?)$/i.test(host)) continue;
    const label = host.split('.')[0].replace(/[^a-z0-9]/g, '');
    if (slugN && label && (label === slugN || slugN.includes(label) || label.includes(slugN))) bySlug = bySlug || host;
    tally[host] = (tally[host] || 0) + 1;
  }
  if (bySlug) return bySlug;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

async function main() {
  console.log(`\n🏛  ${CFG.name} 存量补全(经 Wayback 存档)${DRY_RUN ? ' [DRY-RUN]' : ''} · 目标 ${LIMIT} · offset ${OFFSET}\n`);

  const existing = await sb('/moxie_products?select=domain,slug,status&limit=4000');
  const known = new Set(existing.map((p) => normDomain(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => normDomain(p.domain)));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  console.log('CDX 拉取存档工具页清单…');
  const all = await cdxSlugs();
  console.log(`存档工具页 ${all.length} 个(去重后),从 offset ${OFFSET} 起处理\n`);
  const list = all.slice(OFFSET);

  const tally = { ok: 0, dup: 0, rejected: 0, nodomain: 0, rule: 0, ai: 0, badcat: 0, fail: 0, scanned: 0 };
  for (const { slug, ts, orig } of list) {
    if (tally.ok >= LIMIT) break;
    tally.scanned++;
    let html;
    try { html = await get(`https://web.archive.org/web/${ts}id_/${orig}`, 30000, 3); } catch { tally.fail++; continue; }
    const name = CFG.clean(decodeEnt(pickMeta(html, 'og:title'))).slice(0, 60);
    const og = decodeEnt(pickMeta(html, 'og:description')).slice(0, 600);
    const domain = extractDomain(html, slug);
    if (!name || !domain) { tally.nodomain++; continue; }
    if (rejected.has(domain)) { tally.rejected++; continue; }
    if (known.has(domain)) { tally.dup++; continue; }

    try {
      const r = await screen({ name, domain, og: og || name, occurrence_count: 0, traffic_rank: null }, cats);
      if (r.verdict !== 'keep') {
        console.log(`   ✗ ${name} (${domain}) → ${r.stage === 'rule' ? '规则闸' : 'AI'}拒[${r.kind}]`);
        r.stage === 'rule' ? tally.rule++ : tally.ai++; continue;
      }
      const n = r.normalized;
      if (!n.category_slug || !catId[n.category_slug]) { tally.badcat++; continue; }
      if (!n.tagline_zh) { tally.fail++; continue; }
      const newSlug = uniqueSlug(name, domain, knownSlug);
      const row = {
        slug: newSlug, name, domain,
        tagline: n.tagline_zh, description: n.description_zh,
        category_id: catId[n.category_slug], tags: n.tags,
        price_label: n.price_label, domestic_available: n.domestic_available,
        data_overseas: n.domestic_available !== '是', verified: false, featured: false,
        vote_count: 0, status: 'pending',
      };
      if (DRY_RUN) { console.log(`   ✓[dry] ${name} (${domain}) [${n.category_slug}] ${n.tagline_zh}`); tally.ok++; continue; }
      known.add(domain); knownSlug.add(newSlug);
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
      console.log(`   ✓ ${name} (${domain}) [${n.category_slug}] → pending`);
      tally.ok++;
    } catch (err) {
      if (/duplicate key|23505|domain_unique/i.test(err.message)) tally.dup++;
      else { console.log(`   · ${name} → 失败(${err.message})`); tally.fail++; }
    }
  }

  console.log(`\n汇总:入库 ${tally.ok} · 扫描 ${tally.scanned} · 已收录 ${tally.dup} · 黑名单 ${tally.rejected} · 无名/无域名 ${tally.nodomain} · 规则拒 ${tally.rule} · AI拒 ${tally.ai} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 pending。下次跑加 --offset ${OFFSET + tally.scanned} 继续推进。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
