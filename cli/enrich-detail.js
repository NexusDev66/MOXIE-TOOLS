#!/usr/bin/env node
/**
 * 产品详情页正文 AI 清洗(latemai)
 *
 * 详情页的 核心特点/子墨评测/价格 三块原是写死 demo(147 页同一份 DeepSeek 假内容,
 * 连价格表都是编的 ¥1/¥8)。本脚本给每个 published 产品用 DeepSeek 生成结构化正文,
 * 存到 moxie_products.detail(jsonb){features:[{t,d}], review, pricing},prerender 烤进页面。
 * 同类替代不在这生成(prerender 按同分类真实产品派生)。
 *
 * 跑法:node --env-file=.env.local cli/enrich-detail.js [--limit N] [--force] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 * 需先在 SQL Editor:alter table moxie_products add column if not exists detail jsonb;
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Number(arg('limit', '0')) || 0;
const FORCE = process.argv.includes('--force');
const FETCH = process.argv.includes('--fetch'); // 抓官网摘要当依据(抓到才重生成)
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

const SYS = `你是 AI 工具库编辑,为某工具写详情页正文。要求:
1. 只依据给定资料 + 你确知的事实,不编造功能。
2. 价格红线:绝不写具体金额/币种/数字(如 ¥1/M、$20/月);只能定性(免费/订阅/付费/免费额度)+ "具体价格以官网为准"。
3. 客观、不夸张、不营销。
只输出 JSON:
  features: 数组,3-5 条核心特点,每条 {t:"小标题≤8字", d:"一句话说明≤30字"}
  review:  一句话点评(专业测评口吻):直给判断——最强在哪 + 一个真实定位或短板。禁开头重复工具名、禁"适合XX用户"填充、禁空话形容词;保留真实关键信息(国内需代理/免费/对标对象)。≤ 40 字,利落有观点,不是简介复述
  pricing: 价格说明,1-2 句,定性 + "具体以官网为准",≤ 50 字
不要输出 JSON 以外内容。`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
function pick(html, re) { const m = html.match(re); return m ? m[1].replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim() : ''; }
/** 抓官网首页 → 提取 title + meta/og 描述(失败返回 null) */
async function fetchSite(domain) {
  try {
    const res = await fetch(`https://${domain}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 80000);
    const title = pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc = pick(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)
      || pick(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
      || pick(html, /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i);
    if (!title && !desc) return null;
    return { title: title.slice(0, 120), desc: desc.slice(0, 300) };
  } catch { return null; }
}

async function gen(p, catName, site) {
  const siteBlock = site ? `\n【官网摘要(优先依据此,而非记忆)】\n标题:${site.title}\n描述:${site.desc}` : '';
  const user = `名称:${p.name}\n分类:${catName}\n一句话:${p.tagline}\n简介:${p.description || '(无)'}\n价格档:${p.price_label || '不详'}\n国内可用:${p.domestic_available || '不详'}${siteBlock}\n按系统要求输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.4, max_tokens: 700 }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  const features = Array.isArray(o.features) ? o.features.slice(0, 5)
    .map((f) => ({ t: String(f.t || '').slice(0, 12), d: String(f.d || '').slice(0, 50) }))
    .filter((f) => f.t) : [];
  return { features, review: String(o.review || '').slice(0, 120), pricing: String(o.pricing || '').slice(0, 120) };
}

async function main() {
  console.log(`\n🧹 详情页 AI 清洗${DRY_RUN ? ' [DRY-RUN]' : ''}${FORCE ? ' [FORCE]' : ''}\n`);
  const cats = await sb('/moxie_categories?select=id,name');
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  let q = '/moxie_products?status=eq.published&select=id,name,domain,tagline,description,price_label,domestic_available,category_id,detail&order=weight_score.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const prods = await sb(q);
  // --fetch:遍历全部,抓到官网摘要才重生成(grounding);否则按是否缺 detail 决定
  const todo = FETCH ? prods : prods.filter((p) => FORCE || !p.detail || !p.detail.features || !p.detail.features.length);
  console.log(`共 ${prods.length} 个,处理 ${todo.length} 个${FETCH ? '(--fetch:抓官网做依据)' : ''}\n`);

  const tally = { ok: 0, grounded: 0, skip: 0, fail: 0 };
  for (const p of todo) {
    try {
      let site = null;
      if (FETCH) {
        site = await fetchSite(p.domain);
        if (!site) { tally.skip++; continue; } // 抓不到官网 → 保持现有 detail,不浪费
      }
      const detail = await gen(p, catName[p.category_id] || 'AI 工具', site);
      if (!detail.features.length) { console.log(`  · ${p.name} → 无特点,跳过`); tally.fail++; continue; }
      if (DRY_RUN) { console.log(`  ✓[dry]${site ? '[官网]' : ''} ${p.name}: ${detail.features.map((f) => f.t).join('/')} | ${detail.review.slice(0, 20)}…`); tally.ok++; if (site) tally.grounded++; continue; }
      // 盖 detail.updated_at 时间戳:只在详情真正重生成时更新,不被每日 rank 写 weight_score 干扰
      await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { detail: { ...detail, updated_at: new Date().toISOString() } } });
      console.log(`  ✓${site ? '[官网]' : ''} ${p.name}(${detail.features.length} 特点)`);
      tally.ok++; if (site) tally.grounded++;
    } catch (e) { console.log(`  · ${p.name} → 失败(${e.message})`); tally.fail++; }
  }
  console.log(`\n汇总:清洗 ${tally.ok}(官网依据 ${tally.grounded})· 抓不到跳过 ${tally.skip} · 失败 ${tally.fail}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
