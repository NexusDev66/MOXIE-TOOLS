#!/usr/bin/env node
/**
 * 权重真信号 · Tranco 域名流量排名(latemai)
 *
 * 给每个 published 产品查 Tranco 排名(免费,~1M 域名按流量热度),存 moxie_products.traffic_jsonb
 * {global_rank, source:'tranco', date}。rank.js 的 traffic 项(20 - log10(rank)*3)即生效:
 * 高流量成熟工具(chatgpt rank71→+14)加权,新锐/冷门(不在榜→0)不加。
 *
 * 跑法:node --env-file=.env.local cli/fetch-traffic.js [--limit N] [--force] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。
 * 需先 SQL:alter table moxie_products add column if not exists traffic_jsonb jsonb;
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Number(arg('limit', '0')) || 0;
const FORCE = process.argv.includes('--force');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tranco 取最新排名;不在榜返回 null */
async function trancoRank(domain) {
  const res = await fetch(`https://tranco-list.eu/api/ranks/domain/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Tranco ${res.status}`);
  const j = await res.json();
  const ranks = j.ranks || [];
  if (!ranks.length) return { rank: null, date: null };
  return { rank: ranks[0].rank, date: ranks[0].date };
}

async function main() {
  console.log(`\n📊 Tranco 流量排名${DRY_RUN ? ' [DRY-RUN]' : ''}${FORCE ? ' [FORCE]' : ''}\n`);
  let q = '/moxie_products?status=eq.published&select=id,name,domain,traffic_jsonb&order=weight_score.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const prods = await sb(q);
  const todo = prods.filter((p) => FORCE || !p.traffic_jsonb || typeof p.traffic_jsonb.global_rank === 'undefined');
  console.log(`共 ${prods.length} 个,需查 ${todo.length} 个\n`);

  const tally = { ranked: 0, unranked: 0, fail: 0 };
  for (const p of todo) {
    try {
      const { rank, date } = await trancoRank(p.domain);
      const tj = { global_rank: rank, source: 'tranco', date };
      if (DRY_RUN) { console.log(`  ${rank ? '✓' : '·'} ${p.name} (${p.domain}) → ${rank ?? '未上榜'}`); }
      else { await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { traffic_jsonb: tj } }); }
      if (rank) tally.ranked++; else tally.unranked++;
      await sleep(120);
    } catch (e) { console.log(`  ✗ ${p.name} (${p.domain}) → ${e.message}`); tally.fail++; await sleep(300); }
  }
  console.log(`\n汇总:有排名 ${tally.ranked} · 未上榜 ${tally.unranked} · 失败 ${tally.fail}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
