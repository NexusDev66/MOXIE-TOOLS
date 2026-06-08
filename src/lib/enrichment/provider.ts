import 'server-only';

/**
 * LLM provider 抽象（T5 AC-2）
 *
 * DeepSeek / OpenAI 都是 OpenAI-compatible /chat/completions 接口，
 * 用原生 fetch 直连，不引第三方 SDK（少一层依赖 + 不动 package.json）。
 *
 * 选哪家：env `LLM_PROVIDER`（'deepseek' | 'openai'，默认 deepseek）。
 * key：`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`。
 *
 * 安全：`import 'server-only'` —— 任何 client component import 会 build 失败，
 * 防 API key 漏到前端 bundle。
 */

export type LlmRole = 'system' | 'user' | 'assistant';
export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LlmResult {
  content: string;
  usage: LlmUsage;
  model: string;
  /** 按 provider 报价估算的本次调用成本（美元） */
  cost_usd: number;
}

export interface LlmChatOptions {
  /** 强制 JSON 输出（OpenAI/DeepSeek 都支持 response_format） */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: LlmMessage[], opts?: LlmChatOptions): Promise<LlmResult>;
}

export type ProviderName = 'deepseek' | 'openai';

interface ProviderConfig {
  baseUrl: string;
  model: string;
  envKey: string;
  /** 报价 USD / 1M tokens（估算用，随官方调整，详见 docs/ai-enrichment.md） */
  priceInPerM: number;
  priceOutPerM: number;
}

const CONFIGS: Record<ProviderName, ProviderConfig> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
    priceInPerM: 0.27,
    priceOutPerM: 1.10,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
    priceInPerM: 0.15,
    priceOutPerM: 0.60,
  },
};

const DEFAULT_TIMEOUT_MS = 30_000;

function estimateCost(usage: LlmUsage, cfg: ProviderConfig): number {
  const cost =
    (usage.prompt_tokens / 1_000_000) * cfg.priceInPerM +
    (usage.completion_tokens / 1_000_000) * cfg.priceOutPerM;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 位小数
}

/** OpenAI-compatible /chat/completions 客户端（DeepSeek 与 OpenAI 共用） */
class OpenAICompatibleProvider implements LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  private readonly cfg: ProviderConfig;
  private readonly apiKey: string;

  constructor(name: ProviderName, cfg: ProviderConfig, apiKey: string) {
    this.name = name;
    this.cfg = cfg;
    this.model = cfg.model;
    this.apiKey = apiKey;
  }

  async chat(messages: LlmMessage[], opts: LlmChatOptions = {}): Promise<LlmResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(this.cfg.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 1200,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${this.name} HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: Partial<LlmUsage>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`${this.name} 返回空 content`);
      }

      const usage: LlmUsage = {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        total_tokens: data.usage?.total_tokens ?? 0,
      };

      return {
        content,
        usage,
        model: this.cfg.model,
        cost_usd: estimateCost(usage, this.cfg),
      };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`${this.name} 调用超时（${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 按 env 造一个 provider。
 * @param override 显式指定 provider（不读 env），测试 / 强制切换用
 */
export function createProvider(override?: ProviderName): LlmProvider {
  const name = (override ?? process.env.LLM_PROVIDER ?? 'deepseek').toLowerCase() as ProviderName;
  const cfg = CONFIGS[name];
  if (!cfg) {
    throw new Error(`未知 LLM_PROVIDER: "${name}"（支持 deepseek / openai）`);
  }
  const apiKey = process.env[cfg.envKey];
  if (!apiKey) {
    throw new Error(`${cfg.envKey} 未设置（provider=${name}）`);
  }
  return new OpenAICompatibleProvider(name, cfg, apiKey);
}

/** 测试 / 复用：报价表只读暴露 */
export const PROVIDER_CONFIGS: Readonly<Record<ProviderName, ProviderConfig>> = CONFIGS;
