#!/usr/bin/env node
/**
 * 一次性:把现有 published 产品按 16 分类体系重归类,但**只把工具移入新增的 6 个分类**
 * (ai-audio/ai-design/ai-office/ai-data/ai-marketing/ai-support),不打乱原 10 类成员,churn 最小。
 * 跑法:node --env-file=.env.local cli/reclassify-categories.js [--dry-run] [--limit N]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK = process.env.DEEPSEEK_API_KEY;
const DRY = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv[process.argv.indexOf('--limit') + 1]) || 0) || 0;
if (!SUPABASE_URL || !KEY || !DEEPSEEK) { console.error('❌ 缺 SUPABASE / DEEPSEEK 配置'); process.exit(1); }

const NEW_SLUGS = new Set(['ai-audio', 'ai-design', 'ai-office', 'ai-data', 'ai-marketing', 'ai-support']);

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

async function pick(prod, catLine, slugs) {
  const sys = `你是 AI 工具分类编辑。从给定分类里给这个工具选**唯一最贴合**的一个 slug。只输出 JSON:{"slug":"xxx"}。`;
  const user = `工具:${prod.name}\n一句话:${prod.tagline || ''}\n简介:${(prod.description || '').slice(0, 200)}\n\n【可选分类(slug=名称:说明)】\n${catLine}\n\n规则:优先选最专门的(如配音/音乐→ai-audio;海报/Logo/PPT设计→ai-design;会议/笔记/文档效率→ai-office;数据分析/BI→ai-data;营销/广告/SEO/增长→ai-marketing;客服/SDR/销售→ai-support)。拿不准就选最接近的。只输出 {"slug":"..."}。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0, max_tokens: 40 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('DeepSeek ' + res.status);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const slug = String(JSON.parse(s).slug || '').trim();
  return slugs.has(slug) ? slug : null;
}

async function main() {
  console.log(`\n🗂  按 16 分类重归类(只移入新增 6 类)${DRY ? ' [DRY-RUN]' : ''}\n`);
  const cats = await sb('/moxie_categories?select=id,slug,name,description&order=sort_order');
  const idBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const allSlugs = new Set(cats.map((c) => c.slug));
  const catLine = cats.map((c) => `${c.slug}=${c.name}:${(c.description || '').slice(0, 24)}`).join('\n');

  let q = '/moxie_products?status=eq.published&select=id,name,tagline,description,category_id&order=weight_score.desc.nullslast';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const prods = await sb(q);
  console.log(`待扫描 ${prods.length} 个 published\n`);

  const tally = { moved: 0, kept: 0, fail: 0 };
  const moves = {};
  for (const p of prods) {
    try {
      const slug = await pick(p, catLine, allSlugs);
      if (slug && NEW_SLUGS.has(slug) && idBySlug[slug] !== p.category_id) {
        moves[slug] = (moves[slug] || 0) + 1;
        console.log(`  ↪ ${p.name} → ${slug}`);
        if (!DRY) await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { category_id: idBySlug[slug] } });
        tally.moved++;
      } else tally.kept++;
    } catch (e) { tally.fail++; }
  }
  console.log(`\n汇总:移入新分类 ${tally.moved} · 保持原分类 ${tally.kept} · 失败 ${tally.fail}`);
  console.log('各新分类入账:' + Object.entries(moves).map(([s, n]) => `${s}:${n}`).join('、'));
}
main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
