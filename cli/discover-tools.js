#!/usr/bin/env node
/**
 * Phase 3 · 新锐工具自动管道(Product Hunt)
 *
 * 发现(PH GraphQL)→ AI 中文化补全(DeepSeek)→ 闸门(去重+完整度)→ 入库 status=pending。
 * pending 不直接上站;人工极简 QA 后 promote 成 published(admin 或后续脚本)。
 *
 * 跑法:node --env-file=.env.local cli/discover-tools.js [--limit 20] [--days 7] [--dry-run]
 * 需 env:PH_API_TOKEN、DEEPSEEK_API_KEY、NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。
 * PH 反爬,本机多半连不上 → 在 GitHub Actions 上跑。
 */
import { screen } from './screen.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
// token 两种来源:① 直接给 PH_API_TOKEN(Developer Token);② 给 PH_CLIENT_ID+PH_CLIENT_SECRET 脚本自动换取
let PH_TOKEN = process.env.PH_API_TOKEN;
const PH_CLIENT_ID = process.env.PH_CLIENT_ID;
const PH_CLIENT_SECRET = process.env.PH_CLIENT_SECRET;

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Math.max(1, Number(arg('limit', '20')) || 20);
const DAYS = Math.max(1, Number(arg('days', '7')) || 7);
const TOPIC = arg('topic', 'artificial-intelligence');
const DRY_RUN = process.argv.includes('--dry-run');
const MOCK = process.argv.includes('--mock');  // 本地验证用:绕开 PH 抓取,喂内置候选

// 本地验证候选(PH 形态):真工具 / 聚合站 / 灰产 / 非AI,验证两层清洗 + 入库逻辑
const MOCK_ITEMS = [
  { name: 'Wispr Flow', tagline: 'Voice dictation powered by AI', description: 'Wispr Flow lets you write 3x faster with your voice using AI dictation across every app.', website: 'https://wisprflow.ai', votes: 600, topics: ['Productivity', 'Artificial Intelligence'] },
  { name: 'Granola', tagline: 'AI notepad', description: 'Granola is the AI notepad for people in back-to-back meetings; it transcribes and summarizes your calls.', website: 'https://granola.ai', votes: 1, topics: ['Productivity'] },  // 短 tagline + 低票:验证修复 #1 不再误杀
  { name: 'launch.cab', tagline: 'Submit your startup', description: 'Directory of new startups and tools.', website: 'https://launch.cab', votes: 3, topics: ['Directory'] },
  { name: 'BetSpin', tagline: 'Best casino bonuses', description: 'Online casino with slots, live dealer and sports betting.', website: 'https://betspin-casino.com', votes: 8, topics: ['Gambling'] },
  { name: 'YC News', tagline: 'Social news for hackers', description: 'A social news website focusing on computer science and entrepreneurship.', website: 'https://news.ycombinator.com', votes: 40, topics: ['News'] },
  { name: 'Tamadoggo', tagline: 'AI pet logger', description: 'An AI-powered pet life logger for tracking your dog.', website: 'https://tamadoggo.com', votes: 5, topics: ['Pets'] },  // A5:已拒黑名单 → 应被跳过(验证不再重现)
];

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!MOCK && !PH_TOKEN && !(PH_CLIENT_ID && PH_CLIENT_SECRET)) { console.error('❌ 缺 PH 凭据:给 PH_API_TOKEN,或给 PH_CLIENT_ID + PH_CLIENT_SECRET(应用页都有)。'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

/** 没有现成 token 时,用 client_id+secret 走 client_credentials 换一个 */
async function ensurePhToken() {
  if (PH_TOKEN) return;
  const res = await fetch('https://api.producthunt.com/v2/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: PH_CLIENT_ID, client_secret: PH_CLIENT_SECRET, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`PH 换 token 失败 ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('PH 换 token 无 access_token');
  PH_TOKEN = j.access_token;
  console.log('✓ 已用 client_credentials 换取 PH token');
}

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'tool';
}

// ───── 1. 发现:PH GraphQL ─────
async function discoverPH() {
  const postedAfter = new Date(Date.now() - DAYS * 86400000).toISOString();
  const query = `query{ posts(first: ${LIMIT}, order: VOTES, topic: ${JSON.stringify(TOPIC)}, postedAfter: ${JSON.stringify(postedAfter)}){ edges{ node{ name tagline description website url votesCount topics(first: 5){ edges{ node{ slug name } } } } } } }`;
  const res = await fetch('https://api.producthunt.com/v2/api/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PH_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`PH API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.errors) throw new Error('PH GraphQL: ' + JSON.stringify(j.errors).slice(0, 200));
  return (j.data?.posts?.edges || []).map((e) => e.node).map((n) => ({
    name: n.name, tagline: n.tagline, description: n.description || '',
    website: n.website, phUrl: n.url, votes: n.votesCount,
    topics: (n.topics?.edges || []).map((t) => t.node.name),
  }));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
function cleanHost(h) { return (h || '').replace(/^www\./, '').toLowerCase(); }
function isPH(h) { return /producthunt\.com$/i.test(h || ''); }

/** PH website = producthunt.com/r/<hash> 跳转 → 取真实域名:① manual 读 Location ② follow 终点 ③ 扫 body 外链 */
async function resolveDomain(website) {
  if (!website) return null;
  try {
    const host0 = cleanHost(new URL(website).hostname);
    if (!isPH(host0)) return host0; // 已是真实站

    // ① manual:真 302 会带 Location
    try {
      const r = await fetch(website, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
      const loc = r.headers.get('location');
      if (loc) { const h = cleanHost(new URL(loc, website).hostname); if (!isPH(h)) return h; }
    } catch {}

    // ② follow 到底
    const r2 = await fetch(website, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    const hf = cleanHost(new URL(r2.url).hostname);
    if (!isPH(hf)) return hf;

    // ③ 落地页仍在 PH → 扫 body 找第一个非 PH 外链
    const body = await r2.text();
    const m = body.match(/https?:\/\/(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)[^"'\s<>]*/gi) || [];
    for (const u of m) { try { const h = cleanHost(new URL(u).hostname); if (!isPH(h) && !/\.(png|jpg|svg|css|js|gif|woff2?)$/i.test(h) && !/(google|gstatic|cloudflare|gravatar|amazonaws|twitter|facebook|linkedin|youtube|apple|microsoft|githubassets)\./.test(h)) return h; } catch {} }
    return null;
  } catch { return null; }
}

// ───── 2. 清洗 + 中文化:规则闸 → AI 层(逻辑见 screen.mjs / ai-clean.mjs)─────

async function main() {
  console.log(`\n🚀 Phase 3 新锐发现${DRY_RUN ? ' [DRY-RUN]' : ''}${MOCK ? ' [MOCK]' : ''} · PH topic=${TOPIC} 近${DAYS}天 top${LIMIT}\n`);
  if (!MOCK) await ensurePhToken();

  // 现有产品域名(去重用)+ 分类映射
  const existing = await sb('/moxie_products?select=domain,slug,status&limit=2000');
  const norm = (d) => (d || '').toLowerCase().replace(/^www\./, '');
  const known = new Set(existing.map((p) => norm(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));   // 防 slug 撞车覆盖已有产品
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => norm(p.domain)));  // A5 黑名单(曾拒)
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));   // 喂给 screen/aiClean

  const items = MOCK ? MOCK_ITEMS : await discoverPH();
  console.log(`${MOCK ? 'MOCK' : 'PH'} 候选 ${items.length} 个\n`);

  const tally = { ok: 0, dup: 0, rejected: 0, nodomain: 0, rule: 0, ai: 0, badcat: 0, fail: 0 };
  for (const it of items) {
    const domain = await resolveDomain(it.website);
    if (!domain || /producthunt\.com$/.test(domain)) { console.log(`  · ${it.name} → 无真实域名,跳过`); tally.nodomain++; continue; }
    if (rejected.has(domain)) { console.log(`  ⊘ ${it.name} (${domain}) → 黑名单(曾拒),跳过`); tally.rejected++; continue; }
    if (known.has(domain)) { console.log(`  · ${it.name} (${domain}) → 已收录,跳过`); tally.dup++; continue; }

    try {
      // 两层清洗:规则闸 → AI 层(判定 + 归一)
      // og 取 tagline/description 较长者:真工具用更丰富的描述接地,避免短 tagline 被误判"无描述"
      const og = [it.description, it.tagline].filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
      const raw = { name: it.name, domain, og, occurrence_count: it.votes, traffic_rank: null };
      const r = await screen(raw, cats);
      if (r.verdict !== 'keep') {
        console.log(`  ✗ ${it.name} (${domain}) → ${r.stage === 'rule' ? '规则闸' : 'AI'}拒[${r.kind}]:${r.reason}`);
        r.stage === 'rule' ? tally.rule++ : tally.ai++; continue;
      }
      const e = r.normalized;
      if (!e.category_slug || !catId[e.category_slug]) { console.log(`  · ${it.name} → 分类无法归类,跳过`); tally.badcat++; continue; }
      if (!e.tagline_zh) { console.log(`  · ${it.name} → 归一缺卖点,跳过`); tally.fail++; continue; }

      // 防 slug 撞车:保证最终 slug 唯一(单次后缀仍可能撞 → 循环加序号),绝不复用已有 slug
      let slug = slugify(it.name);
      if (knownSlug.has(slug)) {
        const base = `${slug}-${domain.split('.')[0]}`;
        slug = base;
        for (let i = 2; knownSlug.has(slug); i++) slug = `${base}-${i}`;
      }
      const row = {
        slug, name: it.name, domain,
        tagline: e.tagline_zh, description: e.description_zh,
        category_id: catId[e.category_slug], tags: e.tags,
        price_label: e.price_label, domestic_available: e.domestic_available,
        data_overseas: e.domestic_available !== '是', verified: false, featured: false,
        vote_count: 0, status: 'pending',
      };
      if (DRY_RUN) { console.log(`  ✓[dry] ${it.name} (${domain}) slug=${slug} [${e.category_slug}] ${e.tagline_zh} | ${e.price_label}/${e.domestic_available} | PH票${it.votes}`); tally.ok++; continue; }
      known.add(domain); knownSlug.add(slug);
      // ignore-duplicates:撞 slug 只跳过、绝不覆盖已审产品(配合上面的后缀,正常新品仍能入)
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
      console.log(`  ✓ ${it.name} (${domain}) [${e.category_slug}] → pending`);
      tally.ok++;
    } catch (err) {
      // 防御性:若库启用了 domain UNIQUE(on_conflict=slug 不拦它)→ 计为"已存在"而非失败。
      // 注:实测当前沙盒库**未启用** domain 约束(与 migration 不符)→ 实际去重靠上面的内存 known 集。
      if (/moxie_products_domain_unique|duplicate key|23505/i.test(err.message)) {
        console.log(`  · ${it.name} (${domain}) → domain 已存在(DB 约束),跳过`); tally.dup++;
      } else { console.log(`  · ${it.name} → 处理失败(${err.message}),跳过`); tally.fail++; }
    }
  }

  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 黑名单 ${tally.rejected} · 无域名 ${tally.nodomain} · 规则拒 ${tally.rule} · AI拒 ${tally.ai} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 status=pending。人工审核后 promote 成 published(改 status)再跑 rank+prerender+sitemap 上线。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
