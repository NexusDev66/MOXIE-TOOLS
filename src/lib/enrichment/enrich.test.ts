import { describe, it, expect } from 'vitest';

import { htmlToText, enrichProduct, MAX_TEXT_CHARS } from './enrich';
import {
  buildEnrichmentMessages,
  parseEnrichmentResponse,
  ENRICHMENT_FIELDS,
} from './prompt';
import type { LlmProvider, LlmMessage, LlmResult } from './provider';

/**
 * T5 AC-3 单测：mock LLM provider + 3 个真实产品 fixture。
 *
 * 不打真 API（CI 能跑、零成本、稳定）。覆盖：
 *   - htmlToText 清洗 + 截断
 *   - prompt 组装含产品名/URL/正文
 *   - parseEnrichmentResponse 容错（裸 JSON / ```json 包裹 / 缺字段 / 非法）
 *   - enrichProduct 对 3 个真实产品端到端（mock 返回 → 5 字段 + _meta）
 */

// ── mock provider：按预设 content 返回，记录收到的 messages ──
function mockProvider(content: string): LlmProvider & { lastMessages?: LlmMessage[] } {
  const p: LlmProvider & { lastMessages?: LlmMessage[] } = {
    name: 'mock',
    model: 'mock-model',
    async chat(messages: LlmMessage[]): Promise<LlmResult> {
      p.lastMessages = messages;
      return {
        content,
        usage: { prompt_tokens: 1500, completion_tokens: 200, total_tokens: 1700 },
        model: 'mock-model',
        cost_usd: 0.001,
      };
    },
  };
  return p;
}

// ── 3 个真实产品 fixture（精简版官网正文 HTML）──
const FIXTURES = [
  {
    name: 'Cursor',
    url: 'https://cursor.com',
    html: `<html><head><style>.x{color:red}</style><script>track()</script></head>
      <body><h1>Cursor</h1><p>The AI Code Editor. Built to make you extraordinarily productive.</p>
      <section>Pricing: Free Hobby plan, Pro $20/mo, Business $40/user/mo.</section>
      <div>Built on VS Code. Powered by GPT-4 and Claude.</div></body></html>`,
    // 模拟 LLM 返回
    llm: JSON.stringify({
      features: 'AI 代码编辑器，集成 GPT-4/Claude，提供智能补全、代码生成与重构，大幅提升编程效率。',
      use_cases: '适合个人开发者与团队在日常编码、重构、调试中使用。',
      pricing: '免费 Hobby 档；Pro $20/月；Business $40/人/月。',
      tech_stack: ['VS Code', 'GPT-4', 'Claude'],
      founders: '未知',
    }),
  },
  {
    name: 'Notion',
    url: 'https://notion.so',
    // 用 ```json 代码块包裹，测剥壳
    html: `<body><h1>Notion</h1><p>One workspace. Every team. Docs, wikis, projects.</p>
      <p>Free for personal use. Plus plan $10/mo.</p></body>`,
    llm: '```json\n' + JSON.stringify({
      features: '一体化协作工作空间，整合文档、wiki、项目管理与数据库。',
      use_cases: '适合个人笔记与团队知识库、项目协作。',
      pricing: '个人免费；Plus $10/月。',
      tech_stack: [],
      founders: '未知',
    }) + '\n```',
  },
  {
    name: 'Linear',
    url: 'https://linear.app',
    // 故意缺 founders / tech_stack 字段，测补默认
    html: `<body><h1>Linear</h1><p>The issue tracking tool you'll enjoy using. Built for high-performance teams.</p></body>`,
    llm: JSON.stringify({
      features: '为高效团队打造的问题追踪与项目管理工具，主打速度与简洁。',
      use_cases: '适合软件研发团队管理 issue、迭代与路线图。',
      pricing: '未知',
    }),
  },
] as const;

describe('htmlToText', () => {
  it('去掉 script/style/标签，保留正文', () => {
    const { text } = htmlToText(FIXTURES[0].html);
    expect(text).toContain('Cursor');
    expect(text).toContain('AI Code Editor');
    expect(text).not.toContain('track()');     // script 内容去掉
    expect(text).not.toContain('color:red');   // style 内容去掉
    expect(text).not.toMatch(/<[^>]+>/);        // 没有残留标签
  });

  it('超长正文按 MAX_TEXT_CHARS 截断并标记 truncated', () => {
    const long = '<p>' + 'A'.repeat(MAX_TEXT_CHARS + 5000) + '</p>';
    const { text, truncated } = htmlToText(long);
    expect(truncated).toBe(true);
    expect(text.length).toBe(MAX_TEXT_CHARS);
  });

  it('解码基本 HTML 实体', () => {
    const { text } = htmlToText('<p>Tom &amp; Jerry &lt;3</p>');
    expect(text).toContain('Tom & Jerry <3');
  });
});

describe('buildEnrichmentMessages', () => {
  it('含 system + user，user 带产品名/URL/正文', () => {
    const msgs = buildEnrichmentMessages({ name: 'Cursor', url: 'https://cursor.com', text: '正文片段' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('Cursor');
    expect(msgs[1].content).toContain('https://cursor.com');
    expect(msgs[1].content).toContain('正文片段');
  });
});

describe('parseEnrichmentResponse', () => {
  it('解析裸 JSON，5 字段齐全', () => {
    const e = parseEnrichmentResponse(FIXTURES[0].llm);
    for (const f of ENRICHMENT_FIELDS) expect(e).toHaveProperty(f);
    expect(e.tech_stack).toEqual(['VS Code', 'GPT-4', 'Claude']);
  });

  it('剥掉 ```json 代码块包裹', () => {
    const e = parseEnrichmentResponse(FIXTURES[1].llm);
    expect(e.features).toContain('协作工作空间');
    expect(e.tech_stack).toEqual([]);
  });

  it('缺字段 → 字符串补「未知」、数组补 []', () => {
    const e = parseEnrichmentResponse(FIXTURES[2].llm);
    expect(e.founders).toBe('未知');
    expect(e.tech_stack).toEqual([]);
  });

  it('tech_stack 超 8 个截断、剔除非字符串', () => {
    const e = parseEnrichmentResponse(
      JSON.stringify({ tech_stack: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 123, null] }),
    );
    expect(e.tech_stack).toHaveLength(8);
  });

  it('完全非 JSON → 抛错', () => {
    expect(() => parseEnrichmentResponse('抱歉我无法回答')).toThrow();
  });
});

describe('enrichProduct（3 个真实产品，mock LLM）', () => {
  for (const fx of FIXTURES) {
    it(`${fx.name}: 端到端产出 5 字段 + _meta`, async () => {
      const provider = mockProvider(fx.llm);
      const { enrichment, _meta } = await enrichProduct(
        { name: fx.name, url: fx.url, html: fx.html },
        provider,
      );

      // 5 字段都在
      for (const f of ENRICHMENT_FIELDS) expect(enrichment).toHaveProperty(f);
      expect(enrichment.features.length).toBeGreaterThan(0);

      // prompt 确实拿到了清洗后的正文（含产品名）
      expect(provider.lastMessages?.[1].content).toContain(fx.name);

      // _meta 元数据
      expect(_meta.provider).toBe('mock');
      expect(_meta.model).toBe('mock-model');
      expect(_meta.source_url).toBe(fx.url);
      expect(_meta.prompt_tokens).toBe(1500);
      expect(typeof _meta.cost_usd).toBe('number');
      expect(_meta.enriched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  }

  it('正文为空（纯 JS 页）→ 抛错，不调 LLM', async () => {
    const provider = mockProvider('{}');
    await expect(
      enrichProduct({ name: 'X', url: 'https://x.com', html: '<script>app()</script>' }, provider),
    ).rejects.toThrow(/正文为空/);
    expect(provider.lastMessages).toBeUndefined();
  });
});
