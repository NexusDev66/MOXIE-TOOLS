#!/usr/bin/env node
/**
 * latemai 数据管道 · A5 拒绝(tombstone 黑名单)
 * ------------------------------------------------------------------
 * 把候选/产品标记为 status='rejected'(**不删除**),留作去重墓碑。
 * discover 的 domain 去重是全状态拉取,故被拒域名会自动跳过 → 避免"删了又被重新发现"。
 *
 * 跑法:node --env-file=.env.local cli/reject.mjs <域名|slug> [更多...]
 *   - 库里有该 domain/slug → UPDATE status='rejected'(保留行)
 *   - 库里没有(已删)    → INSERT 最小墓碑行(slug=rej-<域名>, status='rejected')
 * 幂等:重复跑安全。
 *
 * 约定:今后人工 QA 拒绝走这里,不要直接 DELETE(删了会被重新发现)。
 */
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!args.length) { console.error('用法: node cli/reject.mjs <域名|slug> [更多...]'); process.exit(1); }

/** @param {string} path @param {RequestInit & {prefer?:string}} [opts] */
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
const normDomain = (d) => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'x';

/**
 * 拒绝一个域名/slug → tombstone。
 * @param {string} key 域名或 slug
 * @returns {Promise<'updated'|'inserted'|'noop'>}
 */
async function reject(key) {
  const dom = normDomain(key);
  let rows = await sb(`/moxie_products?domain=eq.${encodeURIComponent(dom)}&select=id,status`);
  if (!rows.length) rows = await sb(`/moxie_products?slug=eq.${encodeURIComponent(key)}&select=id,status`);
  if (rows.length) {
    if (rows.every((r) => r.status === 'rejected')) return 'noop';
    const ids = rows.map((r) => r.id).join(',');
    await sb(`/moxie_products?id=in.(${ids})`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'rejected' } });
    return 'updated';
  }
  // 不存在(已删)→ 插墓碑
  await sb('/moxie_products?on_conflict=slug', {
    method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: [{ slug: 'rej-' + slugify(dom), name: dom, domain: dom, tagline: '[已拒绝·黑名单]', status: 'rejected', data_overseas: false, verified: false, featured: false, vote_count: 0 }],
  });
  return 'inserted';
}

console.log(`\n⊘ 拒绝(tombstone)${args.length} 项\n`);
for (const a of args) {
  try {
    const r = await reject(a);
    console.log(`  ${a} → ${r === 'updated' ? '✓ 标记 rejected' : r === 'inserted' ? '✓ 插入墓碑(原已删)' : '· 已是 rejected'}`);
  } catch (e) { console.log(`  ${a} → ❌ ${e.message}`); }
}
console.log('');
