#!/usr/bin/env node
/**
 * 新锐工具发现 · Launch 聚合站 sitemap 源(uneed / microlaunch 同类)
 *
 * 思路(全公开数据,不爬不破解):
 *   1) 读每个站的 sitemap.xml(为 SEO 主动暴露的全站 URL 清单;index 则展开子 sitemap)
 *   2) 按 productRe 过滤出"工具详情页"URL,带 lastmod 的按最新排序 → 取最近 N 个
 *   3) 进详情页读 og:title(工具名)/ og:description(简介)+ 抽出真实官网域名(外链,优先带 ?ref=)
 *   4) 复用 screen(规则闸→AI 清洗中文化)→ 写 moxie_products(status=pending)
 * 与 discover-tools(PH)/ discover-hn(HN)互补,合力支撑"每隔几小时滚动上新"。
 *
 * 跑法:node --env-file=.env.local cli/discover-sitemap.js [--limit 25] [--site microlaunch] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */
import { screen } from './screen.mjs';
import { normDomain, uniqueSlug } from './lib.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Math.max(1, Number(arg('limit', '25')) || 25);   // 每站取最近多少个工具
const ONLY = (arg('site', '') || '').toLowerCase();            // 只跑某个站(调试用)
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 站点配置(已实测两个标杆;加新站照此填:productRe = 工具详情页 URL 特征,strip = 从 og:title 去掉的站名后缀)
// 通用标题清洗:去「Discover/Meet/Introducing 前缀」+「on/is now on/| / - / — + 站名 后缀」,各站没单独 strip 时用它
function genStrip(t, host) {
  const brand = (host.split('.')[0] || '').replace(/[^a-z0-9]/gi, '');
  let s = String(t || '').replace(/^\s*(discover|meet|introducing)\s+/i, '');
  // 这些目录 og:title 多为 "Name | tagline" / "Name — tagline" / "Name | Live" → 取第一个分隔符前作名字
  s = s.split(/\s+[|–—]\s+|\s+-\s+/)[0];
  if (brand) s = s.replace(new RegExp('\\s*(?:is now on|now on|on)\\s*' + brand + '\\b.*$', 'i'), '');
  return s.trim();
}

// 站点配置(sitemap 为主)。productRe = 工具详情页 URL 特征;strip 不填则用 genStrip。
const SITES = [
  { name: 'Microlaunch', host: 'microlaunch.net', sitemap: 'https://microlaunch.net/sitemap.xml', productRe: /microlaunch\.net\/p\/[^/?#]+$/i, strip: (t) => t.replace(/\s+is now on Microlaunch.*$/i, '') },
  { name: 'Uneed', host: 'uneed.best', sitemap: 'https://uneed.best/sitemap.xml', productRe: /uneed\.best\/tool\/[^/?#]+$/i, strip: (t) => t.replace(/^\s*discover\s+/i, '').replace(/\s+on uneed.*$/i, '') },
  // FutureTools:AI 精选目录,详情页外链被 futuretools.link(meta-refresh)包装 → 抓壳页抠真域名(免无头浏览器)
  {
    name: 'FutureTools', host: 'futuretools.io', sitemap: 'https://www.futuretools.io/sitemap.xml',
    productRe: /futuretools\.io\/tools\/[^/?#]+$/i,
    strip: (t) => t.replace(/^\s*Future\s*Tools\s*[-–—|:]\s*/i, ''),
    async resolveDomain(slug) {
      try {
        const body = await get(`https://futuretools.link/${slug}`, 12000);
        const m = body.match(/http-equiv=["']refresh["'][^>]*content=["']\s*\d+\s*;\s*url=([^"']+)["']/i);
        if (!m) return null;
        return new URL(m[1].replace(/&amp;/g, '&')).hostname.replace(/^www\./, '').toLowerCase();
      } catch { return null; }
    },
  },
  { name: 'Foundrlist', host: 'foundrlist.com', sitemap: 'https://foundrlist.com/sitemap.xml', productRe: /foundrlist\.com\/product\/[^/?#]+$/i },
  { name: 'SaaSCity', host: 'saascity.io', sitemap: 'https://saascity.io/sitemap.xml', productRe: /saascity\.io\/live\/[^/?#]+$/i },
  { name: 'MarketingDB', host: 'marketingdb.live', sitemap: 'https://marketingdb.live/sitemap.xml', productRe: /marketingdb\.live\/project\/[^/?#]+$/i },
  // 已探测但未纳入:trustmrr(/startup/ 7787 条但几乎无 AI)、showmeyour(无 AI)、shipstry(productRe 未命中)、
  // fazier/agentwork/confettisaas/launch.cab 等(无可用 sitemap,数据在 __NEXT_DATA__/首页 JS,后续按需特殊处理)
];

// 抽真实域名时要跳过的:社交/平台/CDN/聚合站自身 + 这些聚合站常见的"网络/页脚"外链(非工具本身)
const SKIP_HOST = /(^|\.)(twitter\.com|x\.com|facebook\.com|linkedin\.com|youtube\.com|youtu\.be|instagram\.com|github\.com|producthunt\.com|t\.me|discord\.gg|discord\.com|reddit\.com|medium\.com|gravatar\.com|googleapis\.com|gstatic\.com|cloudflare\.com|cdn\.|google\.com|apple\.com|microsoft\.com|layers\.com|passionfroot\.me|stimpack\.io|buymeacoffee\.com|gumroad\.com)$/i;

// 标题/简介里有这些信号才认为可能是 AI 工具(省 DeepSeek:这些是通用 launch 站,多数非 AI 先筛掉)
const AI_HINT = /\b(ai|a\.i\.|gpt|llm|llms|genai|gen-?ai|agent|agents|agentic|chatbot|chat bot|copilot|assistant|prompt|prompts|rag|diffusion|generative|neural|machine learning|deep learning|\bml\b|transformer|embedding|multimodal|text-to-|speech-to-|image generation|stable diffusion|claude|gemini|mistral|ollama|whisper|sora|语言模型|大模型|智能体|生成式)\b/i;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

async function get(url, timeout = 18000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 读 sitemap;若是 sitemapindex,展开抓子 sitemap(最多 12 个)。返回 [{loc,lastmod}] */
async function fetchSitemap(url, depth = 0) {
  let xml;
  try { xml = await get(url, 45000); } catch (e) { console.log(`   ⚠ sitemap ${url} 取不到(${e.message})`); return []; }
  if (/<sitemapindex/i.test(xml) && depth < 1) {
    const subs = (xml.match(/<loc>([^<]+)<\/loc>/gi) || []).map((m) => m.replace(/<\/?loc>/gi, '').trim()).slice(0, 12);
    const all = [];
    for (const s of subs) all.push(...await fetchSitemap(s, depth + 1));
    return all;
  }
  const out = [];
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/gi) || [];
  for (const b of blocks) {
    const loc = (b.match(/<loc>([^<]+)<\/loc>/i) || [])[1];
    const lastmod = (b.match(/<lastmod>([^<]+)<\/lastmod>/i) || [])[1] || '';
    if (loc) out.push({ loc: loc.trim(), lastmod: lastmod.trim() });
  }
  return out;
}

function pickMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return m ? m[1].trim() : '';
}
function decodeEnt(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'"); }

/** 从详情页 HTML 抽真实官网域名:
 *  优先选「域名主体与页面 slug 吻合」的外链(/p/tagparrot → tagparrot.com),
 *  这样能避开页脚/网络的 ?ref= 干扰链(如 layers.com)。其次才退而求其次取 ref= / 第一个外链。 */
function extractDomain(html, aggHost, slug) {
  const slugN = String(slug || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  const cand = [];
  for (const u of hrefs) {
    let host; try { host = new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }
    if (!host || host === aggHost || host.endsWith('.' + aggHost)) continue;
    if (SKIP_HOST.test(host)) continue;
    if (/\.(png|jpg|jpeg|svg|gif|webp|css|js|ico|woff2?)$/i.test(host)) continue;
    const label = host.split('.')[0].replace(/[^a-z0-9]/g, '');
    const slugMatch = slugN && label && (label === slugN || slugN.includes(label) || label.includes(slugN));
    cand.push({ host, refHit: /[?&]ref=/i.test(u), slugMatch });
  }
  const bySlug = cand.find((c) => c.slugMatch);
  if (bySlug) return bySlug.host;
  const ref = cand.find((c) => c.refHit && !c.slugMatch);
  return (ref || cand[0] || {}).host || null;
}

async function main() {
  console.log(`\n🗺  Launch 聚合站发现(sitemap 源)${DRY_RUN ? ' [DRY-RUN]' : ''} · 每站取最近 ${LIMIT}\n`);

  const existing = await sb('/moxie_products?select=domain,slug,status&limit=3000');
  const known = new Set(existing.map((p) => normDomain(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => normDomain(p.domain)));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  const tally = { ok: 0, dup: 0, rejected: 0, nodomain: 0, rule: 0, ai: 0, badcat: 0, fail: 0 };
  const sites = SITES.filter((s) => !ONLY || s.name.toLowerCase().includes(ONLY) || s.host.includes(ONLY));

  for (const site of sites) {
    console.log(`── ${site.name}(${site.host})──`);
    const entries = (await fetchSitemap(site.sitemap)).filter((e) => site.productRe.test(e.loc));
    entries.sort((a, b) => new Date(b.lastmod || 0) - new Date(a.lastmod || 0));
    const pick = entries.slice(0, LIMIT);
    console.log(`   工具页 ${entries.length} 个,取最近 ${pick.length}`);

    for (const e of pick) {
      let html;
      try { html = await get(e.loc, 14000); } catch { tally.fail++; continue; }
      const rawTitle = decodeEnt(pickMeta(html, 'og:title'));
      const name = (site.strip ? (typeof site.strip === 'function' ? site.strip(rawTitle) : rawTitle.replace(site.strip, '')) : genStrip(rawTitle, site.host)).trim().slice(0, 60);
      const og = decodeEnt(pickMeta(html, 'og:description')).slice(0, 400);
      // 通用 launch 站多数非 AI:标题+简介无 AI 信号先跳过,省 DeepSeek
      if (!AI_HINT.test(`${name} ${og}`)) { tally.notai = (tally.notai || 0) + 1; continue; }
      const slug = (e.loc.match(/\/([^/?#]+)\/?$/) || [])[1] || '';
      const domain = site.resolveDomain ? await site.resolveDomain(slug) : extractDomain(html, site.host, slug);
      if (!name || !domain) { tally.nodomain++; continue; }
      if (rejected.has(domain)) { tally.rejected++; continue; }
      if (known.has(domain)) { tally.dup++; continue; }

      try {
        const raw = { name, domain, og: og || name, occurrence_count: 0, traffic_rank: null };
        const r = await screen(raw, cats);
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
          price_label: n.price_label, domestic_available: n.domestic_available,
          data_overseas: n.domestic_available !== '是', verified: false, featured: false,
          vote_count: 0, status: 'pending',
        };
        if (DRY_RUN) { console.log(`   ✓[dry] ${name} (${domain}) [${n.category_slug}] ${n.tagline_zh}`); tally.ok++; continue; }
        known.add(domain); knownSlug.add(slug);
        await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
        console.log(`   ✓ ${name} (${domain}) [${n.category_slug}] → pending`);
        tally.ok++;
      } catch (err) {
        if (/duplicate key|23505|domain_unique/i.test(err.message)) tally.dup++;
        else { console.log(`   · ${name} → 失败(${err.message})`); tally.fail++; }
      }
    }
  }

  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 黑名单 ${tally.rejected} · 非AI跳过 ${tally.notai || 0} · 无名/无域名 ${tally.nodomain} · 规则拒 ${tally.rule} · AI拒 ${tally.ai} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 pending,等 enrich-detail 补 detail → promote 自动上架。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
