/**
 * AI 补全 prompt + 输出解析（T5 AC-3）
 *
 * 5 字段：功能 / 场景 / 定价 / 技术栈 / 创始人。
 * 纯函数、不碰 secret / 网络 —— 方便单测（mock provider 后只验组装+解析）。
 */

import type { LlmMessage } from './provider';

export interface AiEnrichment {
  /** 功能：做什么 + 核心卖点（中文，1 段） */
  features: string;
  /** 场景：适合谁、什么场景用（中文，1 段） */
  use_cases: string;
  /** 定价：免费 / 订阅 / 价格档位（中文；抓不到写「未知」） */
  pricing: string;
  /** 技术栈：用到的技术 / 模型 / 框架（英文短词，0–8 个） */
  tech_stack: string[];
  /** 创始人 / 团队（抓不到写「未知」） */
  founders: string;
}

export interface EnrichmentInput {
  name: string;
  url: string;
  /** 官网正文（已 HTML→纯文本、已截断） */
  text: string;
}

export const ENRICHMENT_FIELDS = ['features', 'use_cases', 'pricing', 'tech_stack', 'founders'] as const;

const SYSTEM_PROMPT = `你是产品调研助手。任务：根据给定的产品官网正文，抽取结构化信息，输出**简体中文**。

严格规则：
1. 只依据提供的正文，**不要编造**。正文里找不到的字段，字符串填「未知」、数组填 []。
2. 只输出一个 JSON 对象，**不要** markdown 代码块、不要多余解释。
3. 字段（全部必须出现）：
   - features:   做什么 + 核心卖点，1 段中文，≤ 200 字
   - use_cases:  适合谁、什么场景用，1 段中文，≤ 150 字
   - pricing:    定价信息（免费/订阅/价格档位等），中文，≤ 100 字
   - tech_stack: 用到的技术/模型/框架，英文短词数组，0–8 个，每个 ≤ 20 字符
   - founders:   创始人或团队信息，中文，≤ 100 字
4. 不输出营销夸张词；客观陈述。`;

/** 组装发给 LLM 的 messages */
export function buildEnrichmentMessages(input: EnrichmentInput): LlmMessage[] {
  const user = `产品名：${input.name}
官网：${input.url}

官网正文（可能已截断）：
"""
${input.text}
"""

按系统要求输出 JSON。`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 从可能带 ```json 包裹的内容里抠出 JSON 对象文本 */
function extractJsonObject(raw: string): string {
  let s = raw.trim();
  // 去掉 ```json ... ``` 或 ``` ... ``` 包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 退而求其次：取第一个 { 到最后一个 }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  return s;
}

function clampStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '未知';
  const t = v.trim();
  if (!t) return '未知';
  return t.length > max ? t.slice(0, max) : t;
}

function normalizeTechStack(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim().slice(0, 20);
    if (t) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 解析 LLM 返回的 content → AiEnrichment。
 * 容错：剥代码块、缺字段补默认、类型纠正、长度截断。
 * @throws 仅当完全 parse 不出 JSON 时抛错（caller 标记失败）
 */
export function parseEnrichmentResponse(content: string): AiEnrichment {
  const jsonText = extractJsonObject(content);
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`LLM 输出不是合法 JSON: ${content.slice(0, 120)}`);
  }

  return {
    features: clampStr(obj.features, 200),
    use_cases: clampStr(obj.use_cases, 150),
    pricing: clampStr(obj.pricing, 100),
    tech_stack: normalizeTechStack(obj.tech_stack),
    founders: clampStr(obj.founders, 100),
  };
}
