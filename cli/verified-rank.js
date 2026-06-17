#!/usr/bin/env node
/**
 * 「子墨测过」= 每个分类按 weight_score 前 N 名(默认 10),其余清掉 verified。
 *
 * 徽章(子墨测过)全站读 p.verified:列表/详情/首页计数客户端实时读库即时生效;
 * 静态评测块由当趟 prerender 重烤。幂等可重跑——只 PATCH 需要变的那些。
 *
 * 跑法:node --env-file=.env.local cli/verified-rank.js [--top 10] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。
 * 建议跑在 rank.js 之后(用最新 weight_score 定名次)。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const TOP = Number(arg('top', '10')) || 10;
const DRY = process.argv.includes('--dry-run');
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY(.env.local)'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

async function main() {
  console.log(`\n🏅 子墨测过 = 每分类权重前 ${TOP} 名${DRY ? ' [DRY-RUN]' : ''}\n`);
  const ps = await sb('/moxie_products?status=eq.published&select=id,name,category_id,weight_score,verified&limit=2000');
  const cats = await sb('/moxie_categories?select=id,name');
  const catName = Object.fromEntries((cats || []).map((c) => [c.id, c.name]));

  const byCat = {};
  for (const p of ps) { (byCat[p.category_id] = byCat[p.category_id] || []).push(p); }

  const toTrue = [], toFalse = [];
  const rows = [];
  for (const cid of Object.keys(byCat)) {
    const arr = byCat[cid].sort((a, b) => (b.weight_score || 0) - (a.weight_score || 0));
    const keep = Math.min(TOP, arr.length);
    arr.forEach((p, i) => {
      const want = i < TOP;
      if (want && !p.verified) toTrue.push(p);
      if (!want && p.verified) toFalse.push(p);
    });
    rows.push(`  ${(catName[cid] || ('cat ' + cid)).padEnd(12)} ${String(arr.length).padStart(3)} 款 → 保留前 ${keep}`);
  }

  rows.sort();
  console.log(rows.join('\n'));
  const keptTotal = ps.length - toFalse.length - (ps.filter((p) => !p.verified).length - toTrue.length);
  console.log(`\n分类 ${Object.keys(byCat).length} · 需 -verified ${toFalse.length} · 需 +verified ${toTrue.length} · 完成后 verified 总数 ≈ ${ps.filter((p) => p.verified).length - toFalse.length + toTrue.length}`);

  if (DRY) { console.log('\n[dry] 不写库'); return; }

  for (const p of toFalse) {
    for (let t = 1; ; t++) { try { await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { verified: false } }); break; } catch (e) { if (t >= 3) throw e; await new Promise((r) => setTimeout(r, 400 * t)); } }
  }
  for (const p of toTrue) {
    for (let t = 1; ; t++) { try { await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { verified: true } }); break; } catch (e) { if (t >= 3) throw e; await new Promise((r) => setTimeout(r, 400 * t)); } }
  }
  console.log(`\n✓ 完成:-${toFalse.length} / +${toTrue.length}。徽章客户端实时生效;静态页随后 prerender 重烤。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
