#!/usr/bin/env node
/**
 * Phase 4 · SEO 文章自动生成(latemai)
 *
 * 取某分类 top 产品 → DeepSeek 生成横评/选型/手册长文(H2/H3 + FAQ + 长尾词)→ 写 moxie_articles。
 * 之后 cli/prerender.js 会把 published 文章烤成 articles/<slug>.html(带 Article JSON-LD)。
 *
 * 跑法:
 *   node --env-file=.env.local cli/gen-articles.js --category ai-coding --template compare [--limit 3] [--publish] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 *
 * 默认写 status=draft(安全,admin 审后发布);加 --publish 直接上线。
 * 幂等:同 slug 已是非 draft(已发布/已编辑)则跳过,不覆盖。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const CATEGORY = arg('category', null);
const TEMPLATE = arg('template', 'compare');
const LIMIT = Math.max(1, Number(arg('limit', '3')) || 3);
const PUBLISH = process.argv.includes('--publish');
const DRY_RUN = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all'); // 遍历所有分类各生成一篇

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY(.env.local)。先去 platform.deepseek.com 拿 key 填上。'); process.exit(1); }
if (!ALL && !CATEGORY) { console.error('❌ 需 --category <slug>(如 ai-coding)或 --all(全分类批量)。可选 --template compare|pick|guide'); process.exit(1); }
if (!['compare', 'pick', 'guide'].includes(TEMPLATE)) { console.error('❌ --template 仅 compare|pick|guide'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// ───── prompt 矩阵(移植自 T8 src/lib/article-gen/templates.ts)─────
const META = {
  compare: { category: '横评', slugSuffix: 'compare', angle: '横向对比这几款工具:逐项对比核心功能、价格、上手难度、国内可用性,给出"谁更适合谁"的结论,带一个对比小结。' },
  pick: { category: '选型', slugSuffix: 'pick', angle: '选型指南:按不同人群/预算/场景,告诉读者该选哪一款,给清晰的决策建议(如"预算有限选 X、团队协作选 Y")。' },
  guide: { category: '手册', slugSuffix: 'guide', angle: '上手手册:围绕这些工具讲怎么用、典型工作流、常见坑与最佳实践,偏实操 how-to。' },
};
function longtailSeeds(template, products) {
  const names = products.map((p) => p.name);
  const joined = names.join(' vs ');
  if (template === 'compare') return [`${joined} 对比`, `${names[0]} 和 ${names[1] ?? '替代品'} 哪个好`, `${names[0]} 平替`];
  if (template === 'pick') return [`${names[0]} 怎么选`, `${names[0]} 值得买吗`, `${names[0]} 适合谁`];
  return [`${names[0]} 怎么用`, `${names[0]} 教程`, `${names[0]} 使用技巧`];
}
function buildSlug(template, products) {
  const base = products.slice(0, 3).map((p) => p.slug).join('-');
  const s = `${base}-${META[template].slugSuffix}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return s || `ai-tools-${META[template].slugSuffix}`;
}
const SYSTEM_PROMPT = `你是中文 SEO 内容编辑,为「AI 工具导航站」写长文。要求:

1. **只依据给定的产品资料**,不编造不存在的功能/数据。
2. **价格红线**:绝不编造具体金额/币种/档位数字(如 $20/月、￥99)。只能用给定的"价格"字段做定性描述(免费 / 免费+付费 / 订阅 / 付费 / 不详);凡涉及具体价格,统一写"具体价格以官网实测为准"。给定为"不详"时只说"价格以官网为准",不要猜。
3. **长尾关键词**:自然嵌入给定的长尾关键词(标题、小标题、首段各覆盖到),不堆砌。
4. **结构**:正文用 H2/H3 分节(<h2>/<h3>),不要再出 <h1>(标题单独给)。每节有清晰小标题,段落用 <p>。结尾带一个「常见问题」H2,下面 2-3 组问答(<h3>问题</h3><p>答案</p>),利于 schema 抓取。
5. **正文格式**:输出干净的 HTML 片段(只用 h2/h3/p/ul/li/strong),不要 <html>/<body>/markdown 代码块。
6. **篇幅**:正文 800-1500 字,信息密度高、客观、不夸张。

只输出一个 JSON 对象,字段:
  - title:     文章标题,≤ 40 字,含主关键词
  - excerpt:   摘要,≤ 100 字
  - body_html: 正文 HTML 片段(不含 h1)
不要输出 JSON 以外的任何内容。`;
function buildMessages(template, products) {
  const meta = META[template];
  const seeds = longtailSeeds(template, products);
  const block = products.map((p, i) => `${i + 1}. ${p.name}（${p.slug}）\n   一句话:${p.tagline}\n   介绍:${p.description ?? '（无）'}\n   价格:${p.price_label ?? '不详'}　国内可用:${p.domestic_available ?? '不详'}　标签:${(p.tags ?? []).join('/') || '无'}`).join('\n');
  const user = `文章类型:${meta.category}\n写作角度:${meta.angle}\n\n需要自然嵌入的长尾关键词:\n${seeds.map((s) => `- ${s}`).join('\n')}\n\n产品资料:\n${block}\n\n按系统要求输出 JSON。`;
  return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }];
}
function parseArticle(content) {
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  const title = (typeof o.title === 'string' ? o.title.trim() : '');
  const body = (typeof o.body_html === 'string' ? o.body_html.trim() : '');
  if (!title || !body) throw new Error('LLM 输出缺 title/body_html');
  const excerpt = typeof o.excerpt === 'string' ? o.excerpt.trim() : '';
  return { title: title.slice(0, 120), excerpt: (excerpt || title).slice(0, 300), body_html: body };
}
/** 轻量消毒:本就是自家生成、prompt 限定标签;去掉脚本/危险属性兜底 */
function sanitize(html) {
  return html
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|form|input)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}
function readMinutes(html) { return Math.min(120, Math.max(1, Math.round(html.replace(/<[^>]+>/g, '').length / 400))); }

async function callDeepSeek(messages) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, response_format: { type: 'json_object' }, temperature: 0.7, max_tokens: 4000 }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const usage = j.usage || {};
  return { content: j.choices?.[0]?.message?.content || '', usage };
}

/** 给单个分类生成一篇文章。返回 'ok' | 'skip' | 'dry'。 */
async function generateForCategory(cat, template) {
  const tag = `[${cat.slug || cat.name}]`;
  const products = await sb(`/moxie_products?status=eq.published&category_id=eq.${cat.id}&select=id,slug,name,tagline,description,price_label,tags,domestic_available&order=weight_score.desc&limit=${LIMIT}`);
  if (products.length < 2) { console.log(`${tag} 跳过:published 产品不足 2 个(${products.length})`); return 'skip'; }

  const slug = buildSlug(template, products);
  const existing = await sb(`/moxie_articles?slug=eq.${encodeURIComponent(slug)}&select=id,status`);
  if (existing.length && existing[0].status !== 'draft') { console.log(`${tag} 跳过:${slug} 已是 ${existing[0].status}`); return 'skip'; }
  console.log(`${tag} 选品:${products.map((p) => p.name).join(' / ')}`);

  if (DRY_RUN) { console.log(`${tag} [dry] 将写 ${slug}(${PUBLISH ? 'published' : 'draft'})`); return 'dry'; }

  const { content, usage } = await callDeepSeek(buildMessages(template, products));
  const art = parseArticle(content);
  const body = sanitize(art.body_html);
  const row = {
    slug, title: art.title, excerpt: art.excerpt, body_html: body,
    category: META[template].category, read_minutes: readMinutes(body),
    related_product_ids: products.map((p) => p.id),
    status: PUBLISH ? 'published' : 'draft',
  };
  const saved = await sb('/moxie_articles?on_conflict=slug', { method: 'POST', prefer: 'return=representation,resolution=merge-duplicates', body: [row] });
  console.log(`${tag} ✓ #${saved[0]?.id} ${slug}(${row.status}, ${row.read_minutes}min, tok ${usage.prompt_tokens}+${usage.completion_tokens})— ${art.title}`);
  return 'ok';
}

async function main() {
  console.log(`\n✍  Phase 4 文章生成${DRY_RUN ? ' [DRY-RUN]' : ''} · ${ALL ? '全分类' : CATEGORY} · 模板=${TEMPLATE} · status=${PUBLISH ? 'published' : 'draft'}\n`);
  let cats;
  if (ALL) {
    cats = await sb('/moxie_categories?select=id,name,slug&order=sort_order.asc');
  } else {
    cats = await sb(`/moxie_categories?slug=eq.${encodeURIComponent(CATEGORY)}&select=id,name,slug`);
    if (!cats.length) throw new Error(`分类 ${CATEGORY} 不存在`);
  }

  const tally = { ok: 0, skip: 0, dry: 0, fail: 0 };
  for (const cat of cats) {
    try { tally[await generateForCategory(cat, TEMPLATE)]++; }
    catch (e) { tally.fail++; console.log(`[${cat.slug}] ❌ ${e.message}`); }
  }

  console.log(`\n汇总:生成 ${tally.ok} · 跳过 ${tally.skip} · dry ${tally.dry} · 失败 ${tally.fail}`);
  if (tally.ok) console.log(PUBLISH
    ? '已 published → 跑 cli/prerender.js + cli/sitemap.js 上线。'
    : '草稿已写。审核后改 published(或加 --publish 重跑),再跑 prerender.js + sitemap.js 上线。');
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
