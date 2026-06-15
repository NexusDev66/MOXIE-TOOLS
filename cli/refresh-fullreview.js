#!/usr/bin/env node
/**
 * 「子墨完整评测」长文生成 —— 仅 verified(子墨测过)产品
 *
 * 给每个 verified 产品生成一篇第一人称深度实测长文(detail.review_full:段落数组),
 * 详情页「子墨测评」块下用 <details> 折叠展示「阅读完整评测 →」。短评(detail.review)不动。
 *
 * 跑法:node --env-file=.env.local cli/refresh-fullreview.js [--limit N] [--force] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 * 默认只补缺(无 review_full 的);--force 全部重写。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Number(arg('limit', '0')) || 0;
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

const SYS = `你是 AI 工具实测编辑「子墨」。为这个你"亲自上手测过"的工具写一篇第一人称深度评测长文。
要求:
1. 全程第一人称、真实测过的口吻(实测/用下来/试了几天/我拿…来跑)。真实、有体感、有具体场景,不空泛。
2. 4 段,每段 60-110 字,逻辑递进:
   ① 我怎么测的(测了几天、拿什么真实任务/场景上手);
   ② 实测亮点(具体能力 + 真实例子,不堆形容词);
   ③ 不足或注意点(国内是否需代理/免费额度/学习成本/某场景翻车,要诚实);
   ④ 适合谁 + 一句结论性判断。
3. 价格红线:绝不写具体金额/币种/数字,只能定性(免费/订阅/付费/免费额度)+"以官网为准"。
4. 禁夸张营销、禁"强大/领先/革命性"等空话,禁简介复述。专业、克制、有观点。
只输出 JSON:{"paragraphs":["…","…","…","…"]},数组恰好 4 段,不要输出 JSON 以外内容。`;

async function gen(p) {
  const d = p.detail || {};
  const feats = Array.isArray(d.features) ? d.features.map((f) => `${f.t}(${f.d})`).join('；') : '';
  const user = `名称:${p.name}\n分类:${p.catName || 'AI 工具'}\n一句话:${p.tagline || '(无)'}\n核心特点:${feats || '(无)'}\n短评:${d.review || '(无)'}\n测试天数:${d.test_days || '不详'}\n国内可用:${p.domestic_available || '不详'}\n按系统要求,用子墨第一人称深度实测口吻输出 4 段 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.55, max_tokens: 900 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  const paras = Array.isArray(o.paragraphs) ? o.paragraphs.map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 5) : [];
  return paras;
}

async function main() {
  console.log(`\n📝 子墨完整评测 长文生成(仅 verified)${DRY_RUN ? ' [DRY-RUN]' : ''}${FORCE ? ' [FORCE]' : ''}\n`);
  const cats = await sb('/moxie_categories?select=id,name');
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  let q = '/moxie_products?status=eq.published&verified=eq.true&select=id,name,tagline,domestic_available,category_id,detail&order=weight_score.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const prods = await sb(q);
  const todo = FORCE ? prods : prods.filter((p) => !(p.detail && Array.isArray(p.detail.review_full) && p.detail.review_full.length));
  console.log(`verified ${prods.length} 个,待生成 ${todo.length} 个\n`);

  const tally = { ok: 0, fail: 0 };
  for (const p of todo) {
    try {
      p.catName = catName[p.category_id];
      const paras = await gen(p);
      if (paras.length < 3) { console.log(`  · ${p.name} → 段落不足,跳过`); tally.fail++; continue; }
      console.log(`  ${p.name}(${paras.length} 段,${paras.reduce((n, x) => n + x.length, 0)} 字)`);
      if (DRY_RUN) { console.log(`    ${paras[0].slice(0, 40)}…`); tally.ok++; continue; }
      await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { detail: { ...(p.detail || {}), review_full: paras, updated_at: new Date().toISOString() } } });
      tally.ok++;
    } catch (e) { console.log(`  · ${p.name} → 失败(${e.message})`); tally.fail++; }
  }
  console.log(`\n汇总:生成 ${tally.ok} · 失败 ${tally.fail}${DRY_RUN ? '(未写库)' : ''}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
