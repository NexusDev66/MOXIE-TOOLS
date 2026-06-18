#!/usr/bin/env node
/**
 * AI 业界热议 · 名人观点抽取(latemai)
 *
 * --seed:写入 18 条 evergreen 名人观点打底(只需跑一次)。
 * 默认:读最新快讯 → DeepSeek 挑出"某知名人物对 AI 的明确表态"→ 入 moxie_voices(去重),
 *       打重要度分、关联来源快讯。首页按 重要度↓+日期↓ 取 5 条,点击进 /news/<id>。
 *
 * 跑法:node --env-file=.env.local cli/extract-voices.js [--seed] [--limit 40] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 * 需先 SQL 建 moxie_voices 表。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const SEED = process.argv.includes('--seed');
const LIMIT = Number(arg('limit', '40')) || 40;
const DRY_RUN = process.argv.includes('--dry-run');
const RESET = process.argv.includes('--reset');                 // 清掉所有抽取的发言(news_id 非空),种子保留
const ROTATE_DAYS = Number(arg('rotate-days', '45')) || 45;     // 抽取发言保鲜期:超期的清掉(种子不受影响)

const normTake = (s) => String(s || '').replace(/[^一-龥a-zA-Z0-9]/g, '').toLowerCase();

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

const SEEDS = [
  { person: '黄仁勋', role: '英伟达 CEO', take: 'AI 是新的工业革命,自然语言正成为新的编程语言。', importance: 5 },
  { person: 'Sam Altman', role: 'OpenAI CEO', take: 'AGI 可能比多数人预期来得更快,治理要趁早。', importance: 5 },
  { person: 'Geoffrey Hinton', role: '深度学习之父', take: '我们真能控制比自己更聪明的 AI 吗?', importance: 5 },
  { person: 'Yann LeCun', role: 'Meta 首席 AI 科学家', take: '只靠大语言模型到不了 AGI——它们没有世界模型。', importance: 4 },
  { person: '李开复', role: '零一万物 创始人', take: '大模型是 AI 2.0,是平台级、移动互联网级的机会。', importance: 4 },
  { person: '吴恩达', role: 'AI 科学家', take: 'AI 是新的电力,会赋能几乎每个行业。', importance: 4 },
  { person: '马斯克', role: 'xAI 创始人', take: 'AI 是否会成为人类最大的生存风险?', importance: 4 },
  { person: 'Demis Hassabis', role: 'DeepMind CEO', take: 'AI 将加速科学发现,蛋白质折叠只是开始。', importance: 4 },
  { person: 'Dario Amodei', role: 'Anthropic CEO', take: 'AI 的能力和安全必须同步推进。', importance: 4 },
  { person: '李彦宏', role: '百度 CEO', take: '未来人人都能用自然语言编程,不必再学写代码。', importance: 4 },
  { person: '梁文锋', role: 'DeepSeek 创始人', take: '开源 + 极致工程,把大模型成本降一个数量级。', importance: 4 },
  { person: '王小川', role: '百川智能 创始人', take: '做中国的 OpenAI,从医疗等真实场景切入。', importance: 3 },
  { person: '周鸿祎', role: '360 创始人', take: '大模型终将走向开源与普惠。', importance: 3 },
  { person: 'Andrej Karpathy', role: '前特斯拉 AI 总监', take: '最热门的新编程语言是英语;软件进入 3.0 时代。', importance: 4 },
  { person: 'Mustafa Suleyman', role: '微软 AI CEO', take: '未来每个人都会有一个属于自己的 AI 助手。', importance: 3 },
  { person: 'Stuart Russell', role: '伯克利 AI 教授', take: '如何确保 AI 的目标始终与人类一致?', importance: 4 },
  { person: 'Ilya Sutskever', role: '前 OpenAI 首席科学家', take: '规模化仍会持续带来能力的跃迁。', importance: 4 },
  { person: '比尔·盖茨', role: '微软 创始人', take: 'AI 是继 PC、互联网之后最重要的技术变革。', importance: 4 },
];

const SYS = `你从 AI 快讯里抽取「知名人物对 AI 技术 / 行业的实质观点」。极严格,宁缺毋滥。

【只抽这一类】真正的 AI 观点:对 AI 技术路线、行业趋势、研究方向、能力边界、风险 / 治理、商业判断的明确表态、预测或疑问。

【以下一律跳过,绝不抽】
- 人事变动:某人卸任 / 上任 / 离职 / 接任(是公司新闻,不是观点)。
- 个人 / 八卦 / 调侃:财富排名、首富、穿着、敲钟、生活、玩笑(如"成为首富""敲钟穿皮衣""集体穿绿鞋")。
- 公司动态:成立公司、融资、发布产品、业绩数字(除非其中明确含该人对 AI 的判断)。
- 残缺引用:快讯没完整给出此人具体观点的,宁可不抽,绝不写"未完整引用""那句…"之类残句。
- 与 AI 无关的话题(电池、纯硬件、政策本身等),除非直接是对 AI 的看法。

【要求】
- take 必须是该人对 AI 的一句完整、清晰、能独立成立的观点,忠实转述,不编造不夸大不杜撰原话。
- 同一事件 / 同一人只抽最完整的一条,不要近义重复。
- importance 1-5;拿不准它算不算"对 AI 的实质观点",就不抽。
只输出 JSON 数组,每个元素 {i, person, role, take, importance};i 是输入快讯序号。没有可抽的输出 []。不要输出 JSON 以外内容。`;

async function callLLM(messages) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 1500 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a >= 0 && b > a) s = s.slice(a, b + 1); else { const oa = s.indexOf('{'), ob = s.lastIndexOf('}'); if (oa >= 0) { const o = JSON.parse(s.slice(oa, ob + 1)); return o.voices || o.items || []; } }
  return JSON.parse(s);
}

async function doSeed() {
  console.log(`\n🌱 写入 ${SEEDS.length} 条 evergreen 名人观点\n`);
  if (DRY_RUN) { SEEDS.forEach((s) => console.log(`  ${s.importance} ${s.person}:${s.take}`)); return; }
  await sb('/moxie_voices?on_conflict=person,take', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: SEEDS });
  console.log('✓ 种子写入完成');
}

async function doExtract() {
  console.log(`\n🔎 从最新 ${LIMIT} 条快讯抽取名人观点${DRY_RUN ? ' [DRY-RUN]' : ''}\n`);
  const news = await sb(`/moxie_news?select=id,title,summary,source,published_at&order=published_at.desc.nullslast&limit=${LIMIT}`);
  if (!news.length) { console.log('无快讯'); return; }
  const block = news.map((n, i) => `${i}. ${n.title}${n.summary ? ' —— ' + n.summary.slice(0, 80) : ''}`).join('\n');
  const arr = await callLLM([{ role: 'system', content: SYS }, { role: 'user', content: '快讯列表:\n' + block }]);
  if (!Array.isArray(arr) || !arr.length) { console.log('本批未抽到具名人物观点。'); return; }

  // 安全网:即便 LLM 漏判,这些八卦/人事/残句关键词一律不收
  const JUNK = /敲钟|皮衣|绿鞋|首富|万亿|未婚妻|卸任|上任|接任|离职|未完整|那句|穿着|龙虾/;

  let rows = arr.map((v) => {
    const n = news[v.i];
    if (!n || !v.person || !v.take) return null;
    return { person: String(v.person).slice(0, 40), role: String(v.role || '').slice(0, 40), take: String(v.take).slice(0, 120), importance: Math.max(1, Math.min(5, Number(v.importance) || 3)), news_id: n.id, published_at: n.published_at };
  }).filter(Boolean)
    .filter((r) => r.importance >= 3 && !/未具名|无名|匿名/.test(r.person))
    .filter((r) => normTake(r.take).length >= 8 && !JUNK.test(r.take));   // 太短/含八卦关键词 → 丢

  // 批内去重:同一人 + 同一快讯 只留最完整(take 最长)的一条
  const best = new Map();
  for (const r of rows) {
    const k = r.person + '|' + r.news_id;
    if (!best.has(k) || r.take.length > best.get(k).take.length) best.set(k, r);
  }
  rows = [...best.values()];

  // 跨已有去重:同一人 + 同一快讯 或 同一人 + 近似措辞 已存在的,跳过
  const existing = await sb('/moxie_voices?select=person,take,news_id&news_id=not.is.null');
  const seenPN = new Set((existing || []).map((e) => e.person + '|' + e.news_id));
  const seenPT = new Set((existing || []).map((e) => e.person + '|' + normTake(e.take)));
  rows = rows.filter((r) => !seenPN.has(r.person + '|' + r.news_id) && !seenPT.has(r.person + '|' + normTake(r.take)));

  console.log(`清洗+去重后入池 ${rows.length} 条:`);
  rows.forEach((r) => console.log(`  [${r.importance}] ${r.person}(${r.role}): ${r.take.slice(0, 30)} → /news/${r.news_id}`));
  if (DRY_RUN || !rows.length) return;
  await sb('/moxie_voices?on_conflict=person,take', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: rows });
  console.log(`✓ 入池(去重后)`);
}

/** 清理:--reset 清掉全部抽取发言(种子保留);否则轮换删除超 ROTATE_DAYS 天的抽取发言 */
async function cleanupVoices() {
  if (RESET) {
    const doomed = await sb('/moxie_voices?select=id,person,take&news_id=not.is.null') || [];
    console.log(`\n🧹 --reset:删除全部抽取发言(种子 evergreen 保留)共 ${doomed.length} 条${DRY_RUN ? ' [DRY-RUN 不实删]' : ''}`);
    doomed.forEach((r) => console.log(`   - id${r.id} ${r.person}: ${String(r.take).slice(0, 30)}`));
    if (!DRY_RUN && doomed.length) await sb('/moxie_voices?news_id=not.is.null', { method: 'DELETE', prefer: 'return=minimal' });
    return;
  }
  const cutoff = new Date(Date.now() - ROTATE_DAYS * 864e5).toISOString();
  const old = await sb(`/moxie_voices?select=id&news_id=not.is.null&published_at=lt.${cutoff}`) || [];
  if (old.length) {
    console.log(`🧹 轮换:删除 ${old.length} 条超 ${ROTATE_DAYS} 天的抽取发言${DRY_RUN ? ' [DRY-RUN 不实删]' : ''}`);
    if (!DRY_RUN) await sb(`/moxie_voices?news_id=not.is.null&published_at=lt.${cutoff}`, { method: 'DELETE', prefer: 'return=minimal' });
  }
}

async function main() {
  if (SEED) { await doSeed(); return; }
  await cleanupVoices();                                  // 先清理(reset / 轮换)
  if (RESET && !DEEPSEEK_API_KEY) return;                 // 纯 reset 无 key 也行(只删不抽)
  if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY(抽取模式需要)'); process.exit(1); }
  await doExtract();
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
