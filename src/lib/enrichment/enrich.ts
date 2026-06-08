import 'server-only';

/**
 * AI 补全编排（T5 AC-3 / AC-4）
 *
 *   fetchProductHtml(url)            拉官网 HTML（带超时 + UA）
 *   htmlToText(html)                 HTML → 纯文本（去 script/style/标签 + 截断）
 *   enrichProduct({name,url,html})   文本 → LLM → 解析 → 5 字段 + _meta
 *
 * enrichProduct 收 html 字符串（不自己抓），方便单测注入 fixture。
 * server action 用 fetchProductHtml 先抓，再喂进来。
 */

import { createProvider, type LlmProvider, type ProviderName } from './provider';
import {
  buildEnrichmentMessages,
  parseEnrichmentResponse,
  type AiEnrichment,
} from './prompt';

/** 喂给 LLM 的正文上限（控制 token 成本；约 ~6k tokens） */
export const MAX_TEXT_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 15_000;
const UA =
  'Mozilla/5.0 (compatible; MoxieEnrichBot/1.0; +https://latemai.com/install/agent.md)';

export interface EnrichMeta {
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  source_url: string;
  /** 正文是否被 MAX_TEXT_CHARS 截断 */
  truncated: boolean;
  enriched_at: string;
}

export interface EnrichResult {
  enrichment: AiEnrichment;
  _meta: EnrichMeta;
}

const SCRIPT_STYLE_RE = /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /[ \t\f\v]+/g;
const MULTI_NL_RE = /\n\s*\n\s*\n+/g;
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
};

/** HTML → 纯文本：去掉脚本/样式/标签，解基本实体，压空白，按 MAX_TEXT_CHARS 截断 */
export function htmlToText(html: string, cap = MAX_TEXT_CHARS): { text: string; truncated: boolean } {
  const stripped = String(html)
    .replace(SCRIPT_STYLE_RE, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|section|article|header|footer)>/gi, '\n')
    .replace(TAG_RE, ' ');

  const decoded = stripped
    .replace(/&#(\d+);/g, (_, d) => safeCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

  const normalized = decoded
    .replace(WS_RE, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(MULTI_NL_RE, '\n\n')
    .trim();

  if (normalized.length <= cap) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, cap), truncated: true };
}

function safeCode(c: number): string {
  if (!Number.isFinite(c) || c <= 0 || c > 0x10ffff) return '';
  try {
    return String.fromCodePoint(c);
  } catch {
    return '';
  }
}

/** 拉官网 HTML（带超时 + 透明 UA）。失败抛错。 */
export async function fetchProductHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`抓取官网失败 HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`抓取官网超时（${FETCH_TIMEOUT_MS}ms）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface EnrichProductInput {
  name: string;
  url: string;
  html: string;
}

/**
 * 核心：html → 5 字段补全结果 + 调用元数据。
 * @param provider 不传则按 env 造（LLM_PROVIDER）；测试传 mock。
 */
export async function enrichProduct(
  input: EnrichProductInput,
  provider?: LlmProvider,
  providerOverride?: ProviderName,
): Promise<EnrichResult> {
  const llm = provider ?? createProvider(providerOverride);
  const { text, truncated } = htmlToText(input.html);
  if (!text) {
    throw new Error('官网正文为空（可能是纯 JS 渲染页，抓不到文本）');
  }

  const messages = buildEnrichmentMessages({ name: input.name, url: input.url, text });
  const result = await llm.chat(messages, { json: true });
  const enrichment = parseEnrichmentResponse(result.content);

  return {
    enrichment,
    _meta: {
      provider: llm.name,
      model: result.model,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      cost_usd: result.cost_usd,
      source_url: input.url,
      truncated,
      enriched_at: new Date().toISOString(),
    },
  };
}
