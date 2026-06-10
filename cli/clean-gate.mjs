#!/usr/bin/env node
/**
 * latemai 数据管道 · 清洗闸(第一刀 / S1 规则层)
 * ------------------------------------------------------------------
 * 目标:把灰产 / 目录站 / 无信号杂牌挡在门外,只放真 AI 工具进下一层(S2 AI 归一)。
 *
 * 设计原则:
 *   1. 绝不靠"名字猜"单条定生死 —— 名字可疑只 +1 分,真工具靠官网/流量/信号自证清白。
 *   2. 多信号打分,达阈值才拒,降低误杀(Grammarly / Calendly 这种 -ly 真品牌不被冤枉)。
 *   3. 目录站 / 聚合站本身是"源"不是"产品",硬拒。
 *   4. 业务逻辑纯函数 gate(),不碰 Supabase / 不依赖框架,方便单测、复用、跨库迁移。
 *
 * 【需核实】下列阈值与名单都是"未见真数据前"的初值,等拿到真 candidates 后必须按真实分布回校。
 *
 * 跑法(纯离线,用内置 fixture 演示真实判定):
 *   node cli/clean-gate.mjs
 * 接真数据时:import { gate } from './clean-gate.mjs' 喂候选数组即可。
 */

/**
 * @typedef {Object} Candidate     候选工具(清洗闸的输入)
 * @property {string}        name              名称
 * @property {string}        domain            域名(可带协议/路径,内部会归一)
 * @property {string|null}  [og]               官网 og/meta 描述(用于事实接地;空=抓不到)
 * @property {number}       [occurrence_count] 采集信号:被多少来源提及
 * @property {number|null}  [traffic_rank]     流量排名(Tranco 等;越小越热;null=无)
 * @property {string}       [source]           采集来源标记
 */

/**
 * @typedef {Object} GateResult    清洗闸判定结果
 * @property {'pass'|'reject'} verdict  过 / 拒
 * @property {number}          score    风险分(99 = 硬拒)
 * @property {string[]}        reasons  判定理由(可解释,便于人工复核)
 */

// ── 已知"目录站 / 发布站"本身 —— 同类垃圾导航,收录为产品无意义,硬拒 ──
// 【需核实】名单需随真数据增补
/** @type {string[]} */
const AGGREGATOR_DOMAINS = [
  'launch.cab', 'neeed.directory', 'marketingdb.live',
  'theresanaiforthat.com', 'futurepedia.io', 'toolify.ai', 'aitoolhunt.com',
];

// ── 高风险 TLD(灰产高发):不硬拒,加权重 ──
const GRAY_TLD = /\.(cab|directory|live|sbs|top|click|monster|rest|cfd|lol|icu)$/i;

// ── 批量注册"伪品牌"名模式:词根 + ly/ify/zy 等。只 +1 分(防误杀 Grammarly/Calendly)──
const FAKE_BRAND = /^[a-z]{4,}(ly|ify|zy|oly|ely|sy)$/i;

const REJECT_AT = 3; // 风险分阈值,>= 即拒 【需核实:按真实分布回校】

/**
 * 规则层清洗闸:判定一个候选是否放行。
 * @param {Candidate} c
 * @returns {GateResult}
 */
export function gate(c) {
  /** @type {string[]} */
  const reasons = [];
  const name = String(c.name || '').trim();
  const root = String(c.domain || '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

  // 硬拒 1:聚合 / 目录站本身
  if (AGGREGATOR_DOMAINS.some((a) => root === a || root.endsWith('.' + a)))
    return { verdict: 'reject', score: 99, reasons: ['聚合/目录站本身,非产品'] };
  // 硬拒 2:无有效域名
  if (!root || !root.includes('.'))
    return { verdict: 'reject', score: 99, reasons: ['无有效域名'] };

  let score = 0;
  if (GRAY_TLD.test(root)) { score += 2; reasons.push('高风险TLD'); }
  if (!c.og || String(c.og).trim().length < 20) { score += 2; reasons.push('无官网描述(无法事实接地)'); }
  // 流量/采集信号:仅当「两者都缺」才算风险 —— 单一信号缺失不等于垃圾。
  // 【修复 #1】旧版"无 traffic_rank +1"会误杀短 tagline 真工具(PH 等源永不提供 traffic_rank)。
  if ((c.occurrence_count ?? 0) < 2 && c.traffic_rank == null) { score += 1; reasons.push('无任何流量/采集信号'); }
  if (FAKE_BRAND.test(name.replace(/\s/g, ''))) { score += 1; reasons.push('疑似批量伪品牌名'); }
  if (name.length < 2) { score += 1; reasons.push('名称过短'); }

  return { verdict: score >= REJECT_AT ? 'reject' : 'pass', score, reasons };
}

// ────────────────────────── 回归测试 fixture ──────────────────────────
// 每条带 expect 期望值;main() 断言,任一不符即 exit 1(可当回归测试用)。
/** @typedef {Candidate & {expect:'pass'|'reject'}} FixtureRow */
/** @type {FixtureRow[]} */
const FIXTURE = [
  // —— 用户列的灰产 / 目录站(应全拒)——
  { name: 'launch.cab', domain: 'launch.cab', og: '', occurrence_count: 3, traffic_rank: null, expect: 'reject' },
  { name: 'neeed.directory', domain: 'neeed.directory', og: '', occurrence_count: 2, traffic_rank: null, expect: 'reject' },
  { name: 'marketingdb.live', domain: 'marketingdb.live', og: 'marketing database', occurrence_count: 2, traffic_rank: null, expect: 'reject' },
  { name: 'blauwdruk', domain: 'blauwdruk.io', og: '', occurrence_count: 1, traffic_rank: null, expect: 'reject' },
  { name: 'Evaloly', domain: 'evaloly.com', og: '', occurrence_count: 1, traffic_rank: null, expect: 'reject' },
  { name: 'Absencely', domain: 'absencely.com', og: '', occurrence_count: 2, traffic_rank: null, expect: 'reject' },
  { name: 'Corkyly', domain: 'corkyly.app', og: '', occurrence_count: 1, traffic_rank: null, expect: 'reject' },
  { name: 'Dojoyly', domain: 'dojoyly.com', og: '', occurrence_count: 1, traffic_rank: null, expect: 'reject' },
  { name: 'PairUp.chat', domain: 'pairup.chat', og: '', occurrence_count: 1, traffic_rank: null, expect: 'reject' },
  { name: 'LeadClaw', domain: 'leadclaw.top', og: '', occurrence_count: 1, traffic_rank: null, expect: 'reject' },
  // —— 真 AI 工具(应全过)——
  { name: 'ChatGPT', domain: 'chatgpt.com', og: 'ChatGPT helps you get answers, find inspiration and be more productive.', occurrence_count: 50, traffic_rank: 1, expect: 'pass' },
  { name: 'DeepSeek', domain: 'deepseek.com', og: '深度求索 DeepSeek,探索通用人工智能的本质。', occurrence_count: 30, traffic_rank: 120, expect: 'pass' },
  { name: '即梦', domain: 'jimeng.jianying.com', og: '即梦 AI,字节跳动旗下 AI 创作平台,支持 AI 作图与视频。', occurrence_count: 18, traffic_rank: 800, expect: 'pass' },
  { name: 'Midjourney', domain: 'midjourney.com', og: 'Midjourney is an independent research lab exploring new mediums of thought.', occurrence_count: 40, traffic_rank: 90, expect: 'pass' },
  { name: 'Cursor', domain: 'cursor.com', og: 'Cursor is the best way to code with AI.', occurrence_count: 22, traffic_rank: 300, expect: 'pass' },
  // —— 边界:真品牌但名字带 -ly(验证不被名字冤枉)——
  { name: 'Grammarly', domain: 'grammarly.com', og: 'Grammarly makes AI writing convenient. Work smarter with personalized AI guidance.', occurrence_count: 45, traffic_rank: 60, expect: 'pass' },
  { name: 'Calendly', domain: 'calendly.com', og: 'Calendly is the modern scheduling platform for businesses.', occurrence_count: 35, traffic_rank: 150, expect: 'pass' },
  // —— 回归用例(修复 #1):旧版会误杀,修后必须过 ——
  { name: 'Cursor·PH短tagline', domain: 'cursor.com', og: 'The AI Code Editor', occurrence_count: 1200, traffic_rank: null, expect: 'pass' },   // 短 og 但高票
  { name: 'Granola·新品低票', domain: 'granola.ai', og: 'Granola is the AI notepad for people in back-to-back meetings; it transcribes and summarizes.', occurrence_count: 1, traffic_rank: null, expect: 'pass' }, // 低票无流量但有长描述
];

function main() {
  let passN = 0, failN = 0;
  const W = 22;
  console.log('\n清洗闸回归测试(阈值 score >= ' + REJECT_AT + ' 即拒)\n' + '─'.repeat(76));
  for (const c of FIXTURE) {
    const r = gate(c);
    const ok = r.verdict === c.expect;
    ok ? passN++ : failN++;
    const sc = r.score === 99 ? '硬拒' : String(r.score);
    console.log(`${ok ? '✓' : '✗FAIL'} 期望${c.expect.padEnd(6)}实得${r.verdict.padEnd(6)}[${sc.padStart(2)}] ${String(c.name).padEnd(W)} ${r.reasons.join('、') || '信号齐全'}`);
  }
  console.log('─'.repeat(76));
  console.log(`${failN === 0 ? '✅ 全通过' : '❌ 有 ' + failN + ' 条失败'}:${passN}/${FIXTURE.length}\n`);
  if (failN > 0) process.exit(1);
}

// 直接 node 运行才跑回归;被 import 时不跑
if (process.argv[1] && process.argv[1].endsWith('clean-gate.mjs')) main();
