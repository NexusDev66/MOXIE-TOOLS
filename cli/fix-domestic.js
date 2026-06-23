#!/usr/bin/env node
/**
 * 国内可用性补全:把 domestic_available = 不详/空 的产品,按"是国产还是海外"判成
 * 是(国内直连) / 需代理(海外,默认) / 否(明确在华不可用)。老工具同规则。
 * 同时同步 data_overseas = (domestic_available !== '是')。
 *
 * 跑法:node --env-file=.env.local cli/fix-domestic.js [--dry-run] [--limit N]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK = process.env.DEEPSEEK_API_KEY;
const DRY = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv[process.argv.indexOf('--limit') + 1]) || 0) || 0;
if (!SUPABASE_URL || !KEY || !DEEPSEEK) { console.error('❌ 缺 SUPABASE / DEEPSEEK 配置'); process.exit(1); }

const ENUM = ['是', '需代理', '否'];

async function sb(p, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${p}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

const SYS = `你判断一个 AI 工具在"中国大陆"的可用性,只从这 3 个里选一个原样输出:是 / 需代理 / 否。
规则:① 中国团队出品/主要面向中国市场/域名是 .cn 或国内大厂(字节/阿里/腾讯/百度/智谱/月之暗面 等)→"是"(国内可直连)。
② 海外工具(绝大多数 Product Hunt / 海外目录来的)→"需代理"。③ 明确在华被封禁/不可注册→"否"。④ 拿不准时,海外背景→"需代理"(这是安全默认,不是编造)。
只输出 JSON:{"domestic_available":"…"}`;

async function classify(p) {
  const user = `工具:${p.name}\n域名:${p.domain}\n一句话:${p.tagline || ''}\n简介:${(p.description || '').slice(0, 160)}\n输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0, max_tokens: 24 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('DeepSeek ' + res.status);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const v = String(JSON.parse(s).domestic_available || '').trim();
  return ENUM.includes(v) ? v : null;
}

async function main() {
  console.log(`\n🌏 国内可用性补全(不详 → 是/需代理/否)${DRY ? ' [DRY-RUN]' : ''}\n`);
  let q = '/moxie_products?status=eq.published&or=(domestic_available.eq.不详,domestic_available.is.null)&select=id,name,domain,tagline,description&order=created_at.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const ps = await sb(q);
  console.log(`待补 ${ps.length} 个\n`);
  const tally = { fixed: 0, kept: 0, fail: 0 };
  for (const p of ps) {
    try {
      const v = await classify(p);
      if (v) {
        console.log(`  ${p.name}(${p.domain}) → ${v}`);
        if (!DRY) await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { domestic_available: v, data_overseas: v !== '是' } });
        tally.fixed++;
      } else tally.kept++;
    } catch (e) { tally.fail++; }
  }
  console.log(`\n汇总:补全 ${tally.fixed} · 仍不详 ${tally.kept} · 失败 ${tally.fail}`);
}
main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
