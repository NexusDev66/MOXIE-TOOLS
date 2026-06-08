import type { AiEnrichment } from '@/lib/enrichment/prompt';

/**
 * 候选完善度打分（T11 MOXIE-24 / AC-1）
 *
 * 给一个 trend candidate 打 0–100 的「完善度」分:数据越全 → 越够格自动升级到 products。
 * 纯函数、不碰 DB/secret —— 方便单测。
 *
 * 维度与权重(合计 100):
 *   - 有产品名(tool_name_hint)              15   —— upsert 的 name 必填
 *   - 跨站频次(occurrence_count,封顶 3 个源) 15   —— 多源 = 更可信,非噪音
 *   - AI 补全 features(功能)                 20   —— 派生 tagline/description 的主来源
 *   - AI 补全 use_cases(场景)               15
 *   - AI 补全 pricing(定价,非「未知」)       10
 *   - AI 补全 founders(创始人,非「未知」)     5
 *   - AI 补全 tech_stack(技术栈,非空)         5
 *   - 已截图(screenshot_url)                15
 *
 * 注:features + 有名 + 域名 是「能拼出合法 product payload」的最低集;高分天然覆盖。
 * 但自动升级最终仍以 validateProductPayload 为闸门(见 auto-promote.ts),分数只做粗筛。
 */

export interface CandidateForScoring {
  tool_name_hint: string | null;
  tool_domain: string;
  occurrence_count: number | null;
  ai_enrichment_jsonb: AiEnrichment | null;
  screenshot_url: string | null;
}

export interface CompletenessResult {
  /** 0–100 整数 */
  score: number;
  /** 各维度得分,便于 admin 看板/调试 */
  breakdown: Record<string, number>;
  /** 缺失/未达项的人类可读说明 */
  missing: string[];
}

/** 跨站频次满分所需源数 */
const OCCURRENCE_FULL = 3;

const W = {
  name: 15,
  occurrence: 15,
  features: 20,
  use_cases: 15,
  pricing: 10,
  founders: 5,
  tech_stack: 5,
  screenshot: 15,
} as const;

/** 字符串字段是否「填了且不是占位符未知」 */
function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0 && v.trim() !== '未知';
}

export function scoreCandidate(c: CandidateForScoring): CompletenessResult {
  const breakdown: Record<string, number> = {};
  const missing: string[] = [];
  const ai = c.ai_enrichment_jsonb;

  // 有名
  if (filled(c.tool_name_hint)) breakdown.name = W.name;
  else missing.push('产品名');

  // 跨站频次(线性封顶)
  const occ = Math.max(0, c.occurrence_count ?? 0);
  breakdown.occurrence = Math.round((Math.min(occ, OCCURRENCE_FULL) / OCCURRENCE_FULL) * W.occurrence);
  if (occ < OCCURRENCE_FULL) missing.push(`跨站频次(${occ}/${OCCURRENCE_FULL})`);

  // AI 补全各字段
  if (filled(ai?.features)) breakdown.features = W.features;
  else missing.push('AI 功能(features)');

  if (filled(ai?.use_cases)) breakdown.use_cases = W.use_cases;
  else missing.push('AI 场景(use_cases)');

  if (filled(ai?.pricing)) breakdown.pricing = W.pricing;
  else missing.push('AI 定价(pricing)');

  if (filled(ai?.founders)) breakdown.founders = W.founders;
  else missing.push('AI 创始人(founders)');

  if (Array.isArray(ai?.tech_stack) && ai.tech_stack.length > 0) breakdown.tech_stack = W.tech_stack;
  else missing.push('AI 技术栈(tech_stack)');

  // 截图
  if (filled(c.screenshot_url)) breakdown.screenshot = W.screenshot;
  else missing.push('官网截图');

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, breakdown, missing };
}
