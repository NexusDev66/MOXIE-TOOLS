#!/usr/bin/env node
/**
 * 价格档补全:把 price_label = 不详/空 的产品,用 DeepSeek 按"已知事实 + 名称/简介/详情"
 * 重判成**定性价格档**(老工具模式:免费 / 免费+付费 / 订阅 / 付费 / 不详)。
 * 价格红线:只给定性档,**绝不写具体金额/币种/数字**;实在无任何线索才保留"不详"。
 *
 * 跑法:node --env-file=.env.local cli/fix-prices.js [--dry-run] [--limit N]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK = process.env.DEEPSEEK_API_KEY;
const DRY = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv[process.argv.indexOf('--limit') + 1]) || 0) || 0;
if (!SUPABASE_URL || !KEY || !DEEPSEEK) { console.error('❌ 缺 SUPABASE / DEEPSEEK 配置'); process.exit(1); }

const ENUM = ['免费', '免费+付费', '订阅', '付费', '不详'];

async function sb(p, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${p}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

const SYS = `你是 AI 工具定价分类器。只判断**定价模式**,从这 5 个里选一个原样输出:免费 / 免费+付费 / 订阅 / 付费 / 不详。
铁律:
① 绝不输出任何金额/币种/数字(价格红线)。
② **只依据你对"这个具体工具"的真实已知事实**或描述里**明确写出的**定价信息来判断。
③ **如果你并不了解这个具体工具、描述里也没明说定价 → 必须输出"不详",绝对不许猜测/默认**(宁可不详,也不要编一个免费档)。
④ 判定:开源/完全免费→"免费";有免费档又有付费档(且你确知)→"免费+付费";按月订阅会员制→"订阅";纯付费无免费→"付费"。
只输出 JSON:{"price_label":"…"}`;

async function classify(p) {
  const user = `工具:${p.name}\n一句话:${p.tagline || ''}\n简介:${(p.description || '').slice(0, 200)}\n价格说明:${(p.detail && p.detail.pricing) || '(无)'}\n输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0, max_tokens: 30 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('DeepSeek ' + res.status);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const v = String(JSON.parse(s).price_label || '').trim();
  return ENUM.includes(v) ? v : null;
}

async function main() {
  console.log(`\n💰 价格档补全(不详/空 → 定性档)${DRY ? ' [DRY-RUN]' : ''}\n`);
  let q = '/moxie_products?status=eq.published&or=(price_label.eq.不详,price_label.is.null)&select=id,name,tagline,description,detail,price_label&order=created_at.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const ps = await sb(q);
  console.log(`待补 ${ps.length} 个\n`);
  const tally = { fixed: 0, kept: 0, fail: 0 };
  for (const p of ps) {
    try {
      const v = await classify(p);
      if (v && v !== '不详') {
        console.log(`  ${p.name} → ${v}`);
        if (!DRY) await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { price_label: v } });
        tally.fixed++;
      } else tally.kept++;
    } catch (e) { tally.fail++; }
  }
  console.log(`\n汇总:补成定性档 ${tally.fixed} · 仍不详 ${tally.kept} · 失败 ${tally.fail}`);
}
main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
