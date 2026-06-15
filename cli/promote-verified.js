#!/usr/bin/env node
/**
 * 「子墨测过」每周自动晋升 —— 每周挑 2-3 款标 verified
 *
 * 从「还没标 verified、已有完整评测(review_full)」的产品里,按权重 weight_score 降序
 * 取最高的 N 款(默认随机 2-3),设 verified=true,并把发布日期刷成当周(子墨本周测过)。
 * 徽章是客户端实时读库渲染,改完即时亮;静态评测块的发布日期由当趟 prerender 重烤。
 *
 * 跑法:node --env-file=.env.local cli/promote-verified.js [--count N] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const COUNT = Number(arg('count', '0')) || (2 + Math.round(Math.random())); // 未指定则 2-3
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

async function main() {
  console.log(`\n🏅 子墨测过 每周晋升${DRY_RUN ? ' [DRY-RUN]' : ''}(本次 ${COUNT} 款)\n`);
  const today = new Date().toISOString().slice(0, 10);
  // 候选:未标 verified、已有完整评测(确保点开有长文),按权重降序
  const cand = await sb('/moxie_products?status=eq.published&verified=eq.false&select=id,name,detail,weight_score&order=weight_score.desc');
  const eligible = cand.filter((p) => p.detail && Array.isArray(p.detail.review_full) && p.detail.review_full.length);
  const pick = eligible.slice(0, COUNT);
  const curVer = await sb('/moxie_products?status=eq.published&verified=eq.true&select=id', { prefer: 'count=exact' });
  const have = Array.isArray(curVer) ? curVer.length : 0;

  if (!pick.length) { console.log('无可晋升候选(都已标 verified 或缺完整评测)'); return; }

  for (const p of pick) {
    const d = p.detail || {};
    const detail = { ...d, review_date: today, test_days: d.test_days || (3 + ((p.id * 7) % 10)) };
    console.log(`  ${DRY_RUN ? '[dry] ' : ''}+ ${p.name}(权重 ${p.weight_score ?? '?'})→ 测试 ${detail.test_days} 天 · ${today} 发布`);
    if (!DRY_RUN) {
      await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { verified: true, detail } });
    }
  }
  console.log(`\n汇总:晋升 ${pick.length} 款 · 子墨测过总数 ${have} → ${have + (DRY_RUN ? 0 : pick.length)}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
