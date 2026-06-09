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

const CATEGORY_SLUGS = ['llm', 'ai-assistant', 'ai-writing', 'ai-image', 'ai-video', 'ai-coding', 'ai-search', 'rag', 'agent', 'workflow'];

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!PH_TOKEN && !(PH_CLIENT_ID && PH_CLIENT_SECRET)) { console.error('❌ 缺 PH 凭据:给 PH_API_TOKEN,或给 PH_CLIENT_ID + PH_CLIENT_SECRET(应用页都有)。'); process.exit(1); }
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

/** PH website 多为 producthunt.com/r/<hash> 跳转 → 跟随取真实域名 */
async function resolveDomain(website) {
  if (!website) return null;
  try {
    let host = new URL(website).hostname.replace(/^www\./, '');
    if (!/producthunt\.com$/.test(host)) return host; // 已是真实站
    const r = await fetch(website, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    return new URL(r.url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

// ───── 2. AI 中文化补全 ─────
const ENRICH_SYS = `你是 AI 工具库编辑。给你一个海外 AI 工具的英文资料,产出中文入库字段。要求:
1. 只依据给定资料,不编造功能。
2. 价格红线:绝不编造具体金额,price_label 只能用枚举:免费 / 免费+付费 / 订阅 / 付费 / 不详。
3. category_slug 必须从这 10 个里选最贴切的一个:llm, ai-assistant, ai-writing, ai-image, ai-video, ai-coding, ai-search, rag, agent, workflow。
只输出 JSON,字段:
  tagline_zh: 一句话中文卖点,≤ 30 字
  description_zh: 2-3 句中文简介
  category_slug: 上述 10 选 1
  tags: 2-4 个中文短标签数组
  price_label: 上述枚举之一
  domestic_available: 国内可用性,枚举:是 / 否 / 需代理 / 不详(海外工具默认"需代理"除非明显国内可用)
不要输出 JSON 以外内容。`;

async function enrich(item) {
  const user = `名称:${item.name}\n英文一句话:${item.tagline}\n英文简介:${item.description || '(无)'}\nPH 话题:${item.topics.join(', ') || '(无)'}\n按系统要求输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: ENRICH_SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.3, max_tokens: 600 }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  return {
    tagline_zh: (o.tagline_zh || '').toString().slice(0, 30),
    description_zh: (o.description_zh || '').toString().slice(0, 500),
    category_slug: CATEGORY_SLUGS.includes(o.category_slug) ? o.category_slug : null,
    tags: Array.isArray(o.tags) ? o.tags.slice(0, 4).map((t) => String(t).slice(0, 12)) : [],
    price_label: ['免费', '免费+付费', '订阅', '付费', '不详'].includes(o.price_label) ? o.price_label : '不详',
    domestic_available: ['是', '否', '需代理', '不详'].includes(o.domestic_available) ? o.domestic_available : '需代理',
  };
}

async function main() {
  console.log(`\n🚀 Phase 3 新锐发现${DRY_RUN ? ' [DRY-RUN]' : ''} · PH topic=${TOPIC} 近${DAYS}天 top${LIMIT}\n`);
  await ensurePhToken();

  // 现有产品域名(去重用)+ 分类映射
  const existing = await sb('/moxie_products?select=domain&limit=2000');
  const known = new Set(existing.map((p) => (p.domain || '').toLowerCase().replace(/^www\./, '')));
  const cats = await sb('/moxie_categories?select=id,slug');
  const catId = Object.fromEntries(cats.map((c) => [c.slug, c.id]));

  const items = await discoverPH();
  console.log(`PH 返回 ${items.length} 个候选\n`);

  const tally = { ok: 0, dup: 0, nodomain: 0, badcat: 0, fail: 0 };
  for (const it of items) {
    const domain = await resolveDomain(it.website);
    if (!domain || /producthunt\.com$/.test(domain)) { console.log(`  · ${it.name} → 无真实域名,跳过`); tally.nodomain++; continue; }
    if (known.has(domain)) { console.log(`  · ${it.name} (${domain}) → 已收录,跳过`); tally.dup++; continue; }

    try {
      const e = await enrich(it);
      if (!e.category_slug || !catId[e.category_slug]) { console.log(`  · ${it.name} → 分类无法归类,跳过`); tally.badcat++; continue; }
      if (!e.tagline_zh) { console.log(`  · ${it.name} → 补全缺卖点,跳过`); tally.fail++; continue; }

      const slug = slugify(it.name);
      const row = {
        slug, name: it.name, domain,
        tagline: e.tagline_zh, description: e.description_zh,
        category_id: catId[e.category_slug], tags: e.tags,
        price_label: e.price_label, domestic_available: e.domestic_available,
        data_overseas: true, verified: false, featured: false,
        vote_count: 0, status: 'pending',
      };
      if (DRY_RUN) { console.log(`  ✓[dry] ${it.name} (${domain}) [${e.category_slug}] ${e.tagline_zh} | ${e.price_label}/${e.domestic_available} | PH票${it.votes}`); tally.ok++; continue; }
      known.add(domain);
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: [row] });
      console.log(`  ✓ ${it.name} (${domain}) [${e.category_slug}] → pending`);
      tally.ok++;
    } catch (err) { console.log(`  · ${it.name} → 补全失败(${err.message}),跳过`); tally.fail++; }
  }

  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 无域名 ${tally.nodomain} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 status=pending。人工审核后 promote 成 published(改 status)再跑 rank+prerender+sitemap 上线。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
