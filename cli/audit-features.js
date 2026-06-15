#!/usr/bin/env node
/**
 * 核心特点(detail.features)事实审计 —— 只读,出报告,不改库
 *
 * 逐个工具把 name+tagline+features 喂给 DeepSeek,挑出"明显可能杜撰/与实际不符"的特点:
 * 编造的型号/版本号/代号、该工具并不具备的功能、夸大的具体能力。输出 JSON 报告。
 *
 * 跑法:node --env-file=.env.local cli/audit-features.js [--limit N] > 报告.txt
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Number(arg('limit', '0')) || 0;

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, ...opts,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

const SYS = `你是严格的事实核查员,核查一个 AI 工具的"核心特点"列表是否与该工具实际相符。
只挑出**明显可能是杜撰或与实际不符**的特点,重点:
1. 编造的具体型号/版本号/代号(如不存在的 K2.6、编造的内测代号);
2. 该工具实际并不具备的功能;
3. 与该工具定位明显矛盾或夸大的能力。
注意:确实真实的、或只是常规中性描述的,**不要报**;拿不准但合理的,也不要报。只报你有把握的问题项。
输出 JSON:{"flags":[{"feature":"<可疑特点标题>","reason":"<为何可疑,简短>","fix":"<建议:删除 或 改成…>"}]},没有可疑则 {"flags":[]}。不要输出 JSON 以外内容。`;

async function audit(p) {
  const feats = (p.detail?.features || []).map((f) => `- ${f.t}:${f.d}`).join('\n');
  if (!feats) return { flags: [] };
  const user = `工具:${p.name}\n定位:${p.tagline || ''}\n核心特点:\n${feats}\n按系统要求核查并输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 500 }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  s = s.replace(/[ -]+/g, ' ');
  const o = JSON.parse(s);
  return { flags: Array.isArray(o.flags) ? o.flags : [] };
}

async function main() {
  console.log(`\n🔎 核心特点事实审计(只读)\n`);
  let q = '/moxie_products?status=eq.published&select=id,name,tagline,detail&order=weight_score.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const prods = await sb(q);
  let flagged = 0, total = 0;
  for (const p of prods) {
    try {
      const { flags } = await audit(p);
      if (flags.length) {
        flagged++; total += flags.length;
        console.log(`\n⚠ ${p.name}`);
        flags.forEach((f) => console.log(`   · [${f.feature}] ${f.reason} → ${f.fix}`));
      }
    } catch (e) { console.log(`   · ${p.name} 审计失败(${e.message})`); }
  }
  console.log(`\n──────\n汇总:${prods.length} 款中 ${flagged} 款有可疑特点,共 ${total} 条。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
