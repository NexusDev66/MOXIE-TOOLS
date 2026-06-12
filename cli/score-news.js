#!/usr/bin/env node
/**
 * AI 快讯打分 + 分类 + 中文摘要(Toolify「AI 新闻中心」同款数据层)
 *
 * 给每条 moxie_news 用 DeepSeek 生成:
 *   score(重要性 0-10,一位小数)· category(1-3 个分类标签)· summary_zh(干净中文摘要)
 * 配合改版后的 moxie-news.html:头部统计「分析 X 篇,发现 Y 条重要报道(≥5.5)」、评分徽章、分类筛选、排行榜。
 *
 * 跑法:node --env-file=.env.local cli/score-news.js [--limit N] [--dry-run] [--force]
 *   默认只处理「还没打分」的(score 为空);--force 重打全部。
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 * 需先在 SQL Editor:alter table moxie_news add column if not exists score real, add column if not exists category jsonb, add column if not exists summary_zh text;
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Number(arg('limit', '0')) || 0;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

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

const CATS = ['模型发布', '科技巨头', '融资并购', '应用落地', '研究突破', '硬件芯片', '政策监管', '开源', '行业动态', '安全伦理'];
const SYS = `你是 AI 行业新闻编辑。对给定的一条 AI 新闻,做三件事:
1. score:重要性评分 0-10(一位小数)。标准:
   - 8.5-10:重大(头部公司重磅发布 / 重大技术突破 / 大额融资并购 / 重要政策法规)
   - 5.5-8.4:重要(值得关注的产品发布、模型更新、明确的行业进展)
   - 3-5.4:一般(常规更新、地区性小消息、小公司动态)
   - 0-2.9:边角 / 纯营销软文 / 标题党 / 与 AI 关系弱
   客观评估,不虚高,不凑分。
2. category:从【${CATS.join('、')}】里选 1-3 个最贴合的(只能用这些词,原样照抄)。
3. summary_zh:一句话中文摘要,客观说清这条新闻讲了什么(≤60字),不夸张不营销;若原文是英文则翻译归纳。
只输出 JSON:{"score":7.5,"category":["模型发布","开源"],"summary_zh":"…"},不要输出 JSON 以外内容。`;

async function gen(n) {
  const user = `标题:${n.title}\n来源:${n.source || n.tag || '未知'}\n原文摘要:${(n.summary || '(无)').slice(0, 500)}\n按系统要求输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 200 }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  let score = Number(o.score);
  if (isNaN(score)) score = 0;
  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
  const category = Array.isArray(o.category) ? o.category.filter((c) => CATS.includes(c)).slice(0, 3) : [];
  const summary_zh = String(o.summary_zh || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { score, category, summary_zh };
}

async function main() {
  console.log(`\n📊 快讯打分 + 分类 + 中文摘要${DRY_RUN ? ' [DRY-RUN]' : ''}${FORCE ? ' [FORCE]' : ''}\n`);
  let q = '/moxie_news?select=id,title,source,tag,summary,score&order=published_at.desc.nullslast';
  if (!FORCE) q += '&score=is.null';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const news = await sb(q);
  console.log(`待处理 ${news.length} 条\n`);

  const tally = { ok: 0, fail: 0, important: 0 };
  for (const n of news) {
    try {
      const { score, category, summary_zh } = await gen(n);
      const flag = score >= 5.5 ? '🔴' : '  ';
      console.log(`  ${flag} [${score.toFixed(1)}] ${category.join('/')} · ${n.title.slice(0, 36)}`);
      if (score >= 5.5) tally.important++;
      if (!DRY_RUN) {
        await sb(`/moxie_news?id=eq.${n.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { score, category, summary_zh } });
      }
      tally.ok++;
    } catch (e) { console.log(`  · ${n.title.slice(0, 30)} → 失败(${e.message})`); tally.fail++; }
  }
  console.log(`\n汇总:打分 ${tally.ok}(重要 ≥5.5:${tally.important} 条)· 失败 ${tally.fail}${DRY_RUN ? '(未写库)' : ''}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
