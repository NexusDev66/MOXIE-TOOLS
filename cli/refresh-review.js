#!/usr/bin/env node
/**
 * 「子墨测评」点评重写 —— 第一人称实测口吻,≤50 字
 *
 * 只重写 moxie_products.detail.review(保留 tagline/tags/features/pricing 不动)。
 * 详情页「子墨测评」板块用第一人称、亲自上手的实测口吻,真实有体感、有判断。
 *
 * 跑法:node --env-file=.env.local cli/refresh-review.js [--limit N] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Number(arg('limit', '0')) || 0;
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

const SYS = `你是 AI 工具实测编辑「子墨」。用**第一人称、亲自上手实测**的口吻,为这个工具写一句「子墨测评」点评。
要求:
1. 像真用过一段时间后给出的判断:可用"实测 / 用下来 / 上手后 / 试了几天"等起头,真实、有体感。
2. 说出真实体验亮点 + 一个判断或注意点;不夸张、不营销、不堆形容词(禁"强大/领先/革命性")。
3. ≤ 50 字,自然口语但专业,有观点,不是简介的复述。
4. 保留真实关键信息(国内需代理 / 免费 / 对标对象 / 价格优势等)。
好例:"实测推理对标 GPT-4o,价格才 1/10,自部署成本是真低。"
好例:"用下来双引擎确实顺手,但重度依赖联网,断网基本没法用。"
只输出 JSON:{"review":"…"},不要输出 JSON 以外内容。`;

async function gen(p) {
  const d = p.detail || {};
  const feats = Array.isArray(d.features) ? d.features.map((f) => f.t).join('、') : '';
  const user = `名称:${p.name}\n一句话简介:${p.tagline || '(无)'}\n核心特点:${feats || '(无)'}\n旧点评:${d.review || '(无)'}\n按系统要求,用子墨第一人称实测口吻输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.5, max_tokens: 150 }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  return String(o.review || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

async function main() {
  console.log(`\n✍️  子墨测评 点评重写(第一人称实测口吻)${DRY_RUN ? ' [DRY-RUN]' : ''}\n`);
  let q = '/moxie_products?status=eq.published&select=id,name,tagline,detail&order=weight_score.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const prods = await sb(q);
  console.log(`待处理 ${prods.length} 个\n`);

  const tally = { ok: 0, fail: 0 };
  for (const p of prods) {
    try {
      const review = await gen(p);
      if (!review) { console.log(`  · ${p.name} → 空,跳过`); tally.fail++; continue; }
      console.log(`  ${p.name}`);
      console.log(`    旧: ${(p.detail || {}).review || '(无)'}`);
      console.log(`    新: ${review}`);
      if (!DRY_RUN) {
        await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { detail: { ...(p.detail || {}), review, updated_at: new Date().toISOString() } } });
      }
      tally.ok++;
    } catch (e) { console.log(`  · ${p.name} → 失败(${e.message})`); tally.fail++; }
  }
  console.log(`\n汇总:重写 ${tally.ok} · 失败 ${tally.fail}${DRY_RUN ? '(未写库)' : ''}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
