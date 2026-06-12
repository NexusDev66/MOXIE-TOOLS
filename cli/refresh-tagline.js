#!/usr/bin/env node
/**
 * 工具 tagline + tags 重生成(Toolify 风格 · 精准定位)
 *
 * 现有 tagline 由 ai-clean 早期"一句话≤30字"提示词生成,偏空泛。本脚本按 Toolify.ai 的
 * 文案风格重写:一句话精准说清"这是什么 + 用来做什么",并配 3 个功能/品类标签。
 * 抓官网摘要做依据(grounding)→ 定位准确、不编造;抓不到的工具跳过(保留原值)。
 *
 * 跑法:node --env-file=.env.local cli/refresh-tagline.js [--limit N] [--dry-run] [--force]
 *   --dry-run  只打印 旧→新 对比,不写库(先看效果)
 *   --limit N  只处理前 N 个(按权重高→低,试跑用)
 *   --force    不抓官网也重写(默认必须抓到官网才重写,保证定位准)
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Number(arg('limit', '0')) || 0;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');   // 抓不到官网也重写

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

const SYS = `你是 AI 工具库编辑,模仿 Toolify.ai 的简洁精准风格,为某 AI 工具重写:一句话简介 tagline、3个标签 tags、一句点评 review。
要求:
1. tagline:一句**较完整的描述**(不是几个字的短标语),说清"它是什么 + 核心能做什么 + 关键差异点"。
   - 长度约 35-50 字,信息充实、读完就懂这工具,但不啰嗦不重复。
   - **必须含关键差异点**(出品方 / 对标对象 / 核心技术 / 独特能力 / 价格优势),且比"短标语"更具体、信息更全。
   - 好例:"快手自研的 AI 文生视频工具,通过文字描述生成高清短视频,画面与动作连贯,国内可直接使用。"
   - 好例:"对标 GPT-4o 的国产开源大模型,推理与代码能力突出,API 价格仅主流模型的约 1/10,适合规模化部署。"
   - 差例(太短 · 禁止):"快手出品的 AI 文生视频工具"、"国产开源大模型"。
   - 客观不营销,禁空话形容词(强大/领先/革命性);价格只定性或用相对倍数,不编造具体金额。
2. tags:3 个简短功能/品类标签(中文,每个 ≤ 8 字,如 "AI视频生成"/"文生图"/"AI写作助手"),贴合真实用途。
3. review(点评 · 专业测评口吻):一句话直给判断 —— 这工具最强在哪 + 一个真实定位或短板。
   - 禁止:开头重复工具名("XX是…/XX以…")、"适合XX用户/适合XX场景"这类填充、空话形容词。
   - 保留真实关键信息(如 国内需代理 / 免费 / 对标对象 / 价格优势)。
   - ≤ 40 字,利落、有观点,不是简介的复述。
   - 好例:"开源大模型的性价比标杆,推理对标GPT-4o,部署成本极低。"、"AI搜索标杆,实时联网+引用溯源是核心,国内需代理。"
定位红线:只依据【官网摘要】+ 给定资料 + 你确知的事实,功能/定位必须准确,绝不编造能力或夸大范围。
只输出 JSON:{"tagline":"…","tags":["…","…","…"],"review":"…"},不要输出 JSON 以外内容。`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
function pick(html, re) { const m = html.match(re); return m ? m[1].replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim() : ''; }
async function fetchSite(domain) {
  try {
    const res = await fetch(`https://${domain}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 80000);
    const title = pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc = pick(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)
      || pick(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    if (!title && !desc) return null;
    return { title: title.slice(0, 120), desc: desc.slice(0, 300) };
  } catch { return null; }
}

async function gen(p, catName, site) {
  const siteBlock = site ? `\n【官网摘要(优先依据此)】\n标题:${site.title}\n描述:${site.desc}` : '';
  const user = `名称:${p.name}\n网址:${p.domain}\n分类:${catName}\n现有简介:${p.tagline || '(无)'}\n详细描述:${p.description || '(无)'}${siteBlock}\n按系统要求输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.4, max_tokens: 300 }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  const tagline = String(o.tagline || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const tags = Array.isArray(o.tags) ? o.tags.map((t) => String(t).slice(0, 12).trim()).filter(Boolean).slice(0, 3) : [];
  const review = String(o.review || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { tagline, tags, review };
}

async function main() {
  console.log(`\n✏️  tagline 重写(Toolify 风格)${DRY_RUN ? ' [DRY-RUN]' : ''}${FORCE ? ' [FORCE]' : ''}\n`);
  const cats = await sb('/moxie_categories?select=id,name');
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  let q = '/moxie_products?status=eq.published&select=id,name,domain,tagline,description,tags,detail,category_id&order=weight_score.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const prods = await sb(q);
  console.log(`共 ${prods.length} 个待处理\n`);

  const tally = { ok: 0, skip: 0, fail: 0 };
  for (const p of prods) {
    try {
      const site = await fetchSite(p.domain);
      if (!site && !FORCE) { console.log(`  · ${p.name} → 抓不到官网,跳过`); tally.skip++; continue; }
      const { tagline, tags, review } = await gen(p, catName[p.category_id] || 'AI 工具', site);
      if (!tagline) { console.log(`  · ${p.name} → 空,跳过`); tally.fail++; continue; }
      const oldReview = (p.detail && p.detail.review) || '(无)';
      console.log(`  ${p.name}${site ? '[官网]' : ''}`);
      console.log(`    简介旧: ${p.tagline}  | ${(p.tags || []).join('/')}`);
      console.log(`    简介新: ${tagline}  | ${tags.join('/')}`);
      console.log(`    点评旧: ${oldReview}`);
      console.log(`    点评新: ${review || '(模型未给)'}`);
      if (!DRY_RUN) {
        const body = { tagline, tags };
        // 点评合并进 detail,保留 features/pricing,盖 updated_at
        if (review) body.detail = { ...(p.detail || {}), review, updated_at: new Date().toISOString() };
        await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
      }
      tally.ok++;
    } catch (e) { console.log(`  · ${p.name} → 失败(${e.message})`); tally.fail++; }
  }
  console.log(`\n汇总:重写 ${tally.ok} · 抓不到跳过 ${tally.skip} · 失败 ${tally.fail}${DRY_RUN ? '(DRY-RUN 未写库)' : ''}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
