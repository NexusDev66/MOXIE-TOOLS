#!/usr/bin/env node
/**
 * Phase 2 · 权重排序(latemai)
 *
 * 读全部产品 → 算 weight_score → 写回。首页/列表按 weight_score 降序展示。
 * 跑法:node --env-file=.env.local cli/rank.js [--dry-run]
 * 需 SUPABASE_SERVICE_ROLE_KEY(写)。
 *
 * 权重公式(透明可调):
 *   pop      = log10(vote_count+1) * 20      人气(票数,~0..60)
 *   verified = 8                              子墨测过
 *   featured = 15                             当周精选
 *   comp     = 描述4 + 标签≥2:3 + 封面3       完善度(0..10;沙盒无封面 → 那 3 分恒 0)
 *   fresh    = 10 * e^(-天数/60)              时效(新品衰减,0..10)
 *   traffic  = max(0, 20 - log10(global_rank)*3)  Tranco 排名(fetch-traffic 灌;无则 0)
 *   weight_score = pop+verified+featured+comp+fresh+traffic
 *
 * --explain:打印 Top N 每项得分明细(可解释,排查"为何这么排")。
 * 只对 status=published 打分(pending/rejected 不展示,不浪费写)。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const EXPLAIN = process.argv.includes('--explain');
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY(.env.local)');
  process.exit(1);
}

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

const r2 = (x) => Math.round(x * 100) / 100;

/** 拆分每项得分(可解释)。 @returns {{pop:number,ver:number,feat:number,comp:number,fresh:number,traffic:number,total:number}} */
function weightParts(p) {
  const votes = p.vote_count || 0;
  const pop = Math.log10(votes + 1) * 20;
  const ver = p.verified ? 8 : 0;
  const feat = p.featured ? 15 : 0;
  const tags = Array.isArray(p.tags) ? p.tags.length : 0;
  const comp = (p.description ? 4 : 0) + (tags >= 2 ? 3 : 0) + (p.cover_url ? 3 : 0);
  const days = p.created_at ? (Date.now() - new Date(p.created_at).getTime()) / 86400000 : 9999;
  const fresh = 10 * Math.exp(-Math.max(0, days) / 60);
  const gr = p.traffic_jsonb && typeof p.traffic_jsonb.global_rank === 'number' ? p.traffic_jsonb.global_rank : null;
  const traffic = gr && gr > 0 ? Math.max(0, 20 - Math.log10(gr) * 3) : 0;
  return { pop: r2(pop), ver, feat, comp, fresh: r2(fresh), traffic: r2(traffic), total: r2(pop + ver + feat + comp + fresh + traffic) };
}
function weight(p) { return weightParts(p).total; }

async function main() {
  console.log(`\n⚖  Phase 2 权重重算${DRY_RUN ? ' [DRY-RUN]' : ''}\n`);
  // 只对 published 打分(pending/rejected 不展示);traffic_jsonb 由 fetch-traffic.js 灌(Tranco)
  // 注:cover_url 列在真库不存在(cover migration 未生效)→ 不 select,p.cover_url 为 undefined→封面分 0
  const products = await sb('/moxie_products?status=eq.published&select=id,slug,name,vote_count,verified,featured,tags,description,created_at,traffic_jsonb&limit=2000');
  console.log(`   published 产品:${products.length}`);

  const scored = products
    .map((p) => ({ id: p.id, name: p.name, parts: weightParts(p) }))
    .sort((a, b) => b.parts.total - a.parts.total);

  console.log('   Top 8:', scored.slice(0, 8).map((s) => `${s.name}(${s.parts.total})`).join(', '));
  if (EXPLAIN) {
    console.log('\n   明细 Top 12(pop 票数 / ver 实测 / feat 精选 / comp 完善 / fresh 时效 / traffic 流量):');
    for (const s of scored.slice(0, 12)) {
      const w = s.parts;
      console.log(`   ${String(w.total).padStart(7)}  ${s.name}`);
      console.log(`            pop ${w.pop} · ver ${w.ver} · feat ${w.feat} · comp ${w.comp} · fresh ${w.fresh} · traffic ${w.traffic}`);
    }
  }

  if (DRY_RUN) {
    console.log(`\n   [dry] 将更新 ${scored.length} 个 weight_score`);
    return;
  }

  let n = 0;
  for (const s of scored) {
    // 写回带重试:142 个 PATCH 里任一偶发失败(Supabase 5xx/限流)不该让整个 refresh 挂掉
    for (let t = 1; ; t++) {
      try { await sb(`/moxie_products?id=eq.${s.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { weight_score: s.parts.total } }); break; }
      catch (e) { if (t >= 3) throw e; await new Promise((r) => setTimeout(r, 400 * t)); }
    }
    n++;
  }
  console.log(`\n✓ 已更新 ${n} 个 weight_score。UI 按 weight_score 降序即生效。\n`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
