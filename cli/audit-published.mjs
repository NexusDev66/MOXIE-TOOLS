#!/usr/bin/env node
/**
 * latemai 数据管道 · B1 存量体检(只读,不写库)
 * ------------------------------------------------------------------
 * 用 AI 层(ai-clean)对现有 status=published 产品做分类复审,
 * 列出"可疑"的(verdict≠keep 或 kind≠ai_tool)——非AI / 灰产 / 拿不准 / 死站,
 * 供人工决定是否 reject(走 cli/reject.mjs)。本脚本只读,不改任何数据。
 *
 * 跑法:node --env-file=.env.local cli/audit-published.mjs [--limit N] [--conc 5]
 */
import { aiClean } from './ai-clean.mjs';

const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const argn = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) || d : d; };
const LIMIT = argn('--limit', 0);
const CONC = argn('--conc', 5);

async function get(p) {
  const r = await fetch(URL + '/rest/v1' + p, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error('Supabase ' + r.status);
  return r.json();
}

/** 并发池 @template T,R @param {T[]} items @param {number} n @param {(x:T)=>Promise<R>} fn @returns {Promise<R[]>} */
async function pool(items, n, fn) {
  const ret = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx]); }
  }));
  return ret;
}

const cats = await get('/moxie_categories?select=slug,name&order=sort_order');
let q = '/moxie_products?status=eq.published&select=slug,name,domain,tagline,description&order=weight_score.desc';
if (LIMIT) q += '&limit=' + LIMIT;
const prods = await get(q);
console.log(`\n🔬 B1 存量体检:${prods.length} 个 published · 并发 ${CONC}(只读,不写库)\n`);

let err = 0;
const results = await pool(prods, CONC, async (p) => {
  const og = [p.description, p.tagline].filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  try {
    const r = await aiClean({ name: p.name, domain: p.domain || '', og, price_label: '' }, cats);
    return { slug: p.slug, name: p.name, domain: p.domain, kind: r.kind, verdict: r.verdict, reason: r.reason };
  } catch (e) { err++; return { slug: p.slug, name: p.name, domain: p.domain, kind: 'ERR', verdict: 'err', reason: e.message }; }
});

const flagged = results.filter((r) => r.verdict !== 'keep' || r.kind !== 'ai_tool');
console.log(`=== 体检完成:${results.length} 个,可疑 ${flagged.length}(其中调用错误 ${err})===\n`);
for (const f of flagged) console.log(`  ⚠ [${f.kind}/${f.verdict}] ${f.name} (${f.domain})\n      slug=${f.slug} — ${f.reason}`);
if (!flagged.length) console.log('  ✅ 全部判为真 AI 工具,存量很干净');
console.log('');
