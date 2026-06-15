#!/usr/bin/env node
/**
 * 候选清洗 —— 用现成 prefilter+gate 批量筛 moxie_trend_candidates 里的灰产/目录站杂牌
 *
 * 背景:trend-scanner 旧版入库不过闸,堆了 306 个海外灰产候选(launch.cab/Evaloly…)。
 * 本脚本对 pending 候选跑规则层判定(纯规则、零 LLM 成本、确定性):
 *   - prefilter 拒(目录站域名 / 灰产 TLD)或 gate 判 reject(无信号杂牌)→ 标 status=rejected
 *   - 其余保持 pending(留人工/promote 流程)
 * 只改 status,绝不删行(可回滚);真工具(有 occurrence 信号)不会被误杀。
 *
 * 跑法:node --env-file=.env.prod cli/clean-candidates.js [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。
 */

import { prefilter, gate } from './clean-gate.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置(用 .env.prod)'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

/** 判定一条候选:返回 {reject, reason}。候选无 og,靠域名/名字/出现次数判 */
function judge(c) {
  const name = c.tool_name_hint || c.product_key || '';
  const domain = c.tool_domain || '';
  const pf = prefilter(name, domain);
  if (pf.reject) return { reject: true, reason: pf.reason };
  const g = gate({ name, domain, og: null, occurrence_count: c.occurrence_count ?? 0, traffic_rank: null });
  return { reject: g.verdict === 'reject', reason: g.reasons.join('、') };
}

async function main() {
  console.log(`\n🧹 候选清洗(规则层,零LLM成本)${DRY_RUN ? ' [DRY-RUN]' : ''}\n`);
  const cands = await sb('/moxie_trend_candidates?status=eq.pending&select=id,product_key,tool_name_hint,tool_domain,occurrence_count&order=occurrence_count.desc&limit=2000');
  if (!cands.length) { console.log('无 pending 候选'); return; }

  const toReject = [];
  for (const c of cands) {
    const r = judge(c);
    if (r.reject) toReject.push({ c, reason: r.reason });
  }
  console.log(`pending ${cands.length} · 判为灰产/杂牌 ${toReject.length} · 保留 ${cands.length - toReject.length}\n`);
  toReject.slice(0, 25).forEach(({ c, reason }) => console.log(`  ✗ ${c.tool_name_hint || c.product_key} (${c.tool_domain}) [${c.occurrence_count}] — ${reason}`));
  if (toReject.length > 25) console.log(`  …另 ${toReject.length - 25} 条`);

  if (DRY_RUN) { console.log(`\n[dry] 未写库。去掉 --dry-run 执行标记 rejected。`); return; }

  let done = 0;
  for (const { c } of toReject) {
    try { await sb(`/moxie_trend_candidates?id=eq.${c.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'rejected' } }); done++; }
    catch (e) { console.log(`  ! ${c.product_key} 失败:${e.message}`); }
  }
  console.log(`\n汇总:标 rejected ${done} 条(可回滚:改回 pending)。保留 ${cands.length - toReject.length} 条待 promote。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
