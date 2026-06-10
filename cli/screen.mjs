#!/usr/bin/env node
/**
 * latemai 数据管道 · S3 发现管道清洗中间件
 * ------------------------------------------------------------------
 * 把"规则闸(clean-gate)→ AI 层(ai-clean)"串成一个统一入口,供各 discover-* 复用:
 *   screen(raw, cats) →
 *     1. gate(raw)   规则闸:目录站/灰产/无信号 直接拒(省一次 DeepSeek 调用)。
 *     2. aiClean(raw,cats)  过闸的才送 AI:判 keep/reject + 归一中文字段。
 *
 * 设计:纯函数、不碰 Supabase,可单测、可被任意发现源复用。
 *
 * 本地自测(真调 DeepSeek,不需要 PH token;需沙盒库取分类):
 *   node --env-file=.env.local cli/screen.mjs
 */
import { gate } from './clean-gate.mjs';
import { aiClean } from './ai-clean.mjs';

/**
 * @typedef {import('./clean-gate.mjs').Candidate} Candidate
 * @typedef {import('./ai-clean.mjs').AiCleanResult} AiCleanResult
 */
/**
 * @typedef {Object} ScreenResult
 * @property {'keep'|'reject'} verdict
 * @property {'rule'|'ai'}     stage     在哪一层定的(规则闸 / AI 层)
 * @property {string}          kind      ai_tool/not_ai/gray/dead/unknown/aggregator…
 * @property {string}          reason
 * @property {import('./ai-clean.mjs').Normalized|null} normalized
 */

/**
 * 两层清洗:规则闸 → AI 层。
 * @param {Candidate} raw
 * @param {{slug:string,name:string}[]} cats
 * @returns {Promise<ScreenResult>}
 */
export async function screen(raw, cats) {
  const g = gate(raw);
  if (g.verdict === 'reject')
    return { verdict: 'reject', stage: 'rule', kind: 'rule_block', reason: g.reasons.join('、'), normalized: null };
  const a = await aiClean(raw, cats);
  return { verdict: a.verdict, stage: 'ai', kind: a.kind, reason: a.reason, normalized: a.normalized };
}

// ────────────────────────── 本地自测 ──────────────────────────
// mock 候选(PH 形态),真调 DeepSeek,验证两层串联:聚合站→规则拒、灰产/非AI→AI拒、真工具→keep+归一。
/** @type {Candidate[]} */
const MOCK = [
  { name: 'Cursor', domain: 'cursor.com', og: 'Cursor is the best way to code with AI. Built to make you extraordinarily productive.', occurrence_count: 1200, traffic_rank: null },
  { name: 'launch.cab', domain: 'launch.cab', og: 'Submit and discover new startups and tools.', occurrence_count: 3, traffic_rank: null },
  { name: 'BetSpin', domain: 'betspin-casino.com', og: 'Online casino with slots, live dealer games and sports betting. Claim your welcome bonus.', occurrence_count: 8, traffic_rank: null },
  { name: 'YC News', domain: 'news.ycombinator.com', og: 'A social news website focusing on computer science and entrepreneurship.', occurrence_count: 40, traffic_rank: null },
];

async function sb(path) {
  const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  const K = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${URL}/rest/v1${path}`, { headers: { apikey: K, Authorization: `Bearer ${K}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

async function main() {
  console.log('\n🧪 S3 清洗中间件 self-test(规则闸 → AI 层,真调 DeepSeek)\n' + '─'.repeat(60));
  const cats = await sb('/moxie_categories?select=slug,name&order=sort_order');
  for (const c of MOCK) {
    try {
      const r = await screen(c, cats);
      const mark = r.verdict === 'keep' ? '✓ keep' : '✗ reject';
      console.log(`${mark}  [${r.stage}/${r.kind}] ${c.name} — ${r.reason}`);
      if (r.normalized) console.log(`        归一:${r.normalized.tagline_zh} | ${r.normalized.category_slug} | ${r.normalized.price_label}/${r.normalized.domestic_available}`);
    } catch (e) { console.log(`⚠ ${c.name} — ${e.message}`); }
  }
  console.log('─'.repeat(60) + '\n预期:Cursor keep;launch.cab 规则拒;BetSpin gray;YC News not_ai。\n');
}

if (process.argv[1] && process.argv[1].endsWith('screen.mjs')) main().catch((e) => { console.error('❌', e.message); process.exit(1); });
