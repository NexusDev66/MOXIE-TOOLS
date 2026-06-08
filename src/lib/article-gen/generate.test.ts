import { describe, it, expect } from 'vitest';

import { generateArticleDraft } from './generate';
import {
  buildArticlePrompt,
  parseGeneratedArticle,
  buildArticleSlug,
  estimateReadMinutes,
  ARTICLE_TEMPLATES,
  type ArticleTemplate,
  type ProductForArticle,
} from './templates';
import type { LlmProvider, LlmMessage, LlmResult } from '@/lib/enrichment/provider';

/**
 * T8 AC-4 单测:mock LLM + mock supabase,验 3 个模板都能产出 draft。
 * 不打真 API、不连真库。
 */

const PRODUCTS: ProductForArticle[] = [
  { slug: 'cursor', name: 'Cursor', tagline: 'AI 代码编辑器', description: 'AI 原生 IDE', price_label: '$20/月', tags: ['编程', 'IDE'], domestic_available: 'partial' },
  { slug: 'copilot', name: 'GitHub Copilot', tagline: 'AI 结对编程', description: '代码补全', price_label: '$10/月', tags: ['编程'], domestic_available: 'partial' },
];

// mock provider:返回一篇合法文章 JSON,并记录收到的 messages
function mockProvider(article: { title: string; excerpt: string; body_html: string }): LlmProvider & { lastMessages?: LlmMessage[] } {
  const p: LlmProvider & { lastMessages?: LlmMessage[] } = {
    name: 'mock',
    model: 'mock-model',
    async chat(messages: LlmMessage[]): Promise<LlmResult> {
      p.lastMessages = messages;
      return {
        content: JSON.stringify(article),
        usage: { prompt_tokens: 800, completion_tokens: 1200, total_tokens: 2000 },
        model: 'mock-model',
        cost_usd: 0.003,
      };
    },
  };
  return p;
}

// mock supabase:moxie_products 读 + moxie_articles 查/插/改
// existing:模拟同 slug 已存在的行(null=不存在 → INSERT;有则 UPDATE)
function fakeSb(
  products: ProductForArticle[],
  capture?: { row?: Record<string, unknown> },
  existing?: { id: number; slug: string; status: string } | null,
) {
  return {
    from(table: string) {
      if (table === 'moxie_products') {
        return { select: () => ({ in: async () => ({ data: products, error: null }) }) };
      }
      if (table === 'moxie_articles') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existing ?? null, error: null }) }) }),
          insert: (row: Record<string, unknown>) => {
            if (capture) capture.row = row;
            return {
              select: () => ({
                single: async () => ({ data: { id: 7, slug: row.slug, status: row.status }, error: null }),
              }),
            };
          },
          update: (row: Record<string, unknown>) => {
            if (capture) capture.row = row;
            return {
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: { id: existing?.id ?? 7, slug: existing?.slug ?? 'x', status: existing?.status ?? 'draft' },
                    error: null,
                  }),
                }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

const SAMPLE = {
  title: 'Cursor vs GitHub Copilot 对比:AI 编程工具怎么选',
  excerpt: '两款主流 AI 编程助手横向对比,帮你选对工具。',
  body_html: '<h2>核心功能对比</h2><p>Cursor 与 GitHub Copilot……</p><h2>常见问题</h2><h3>哪个更便宜?</h3><p>Copilot $10/月。</p>',
};

describe('buildArticlePrompt', () => {
  it('含 system + user,user 带产品名 + 长尾关键词 + 结构要求', () => {
    const msgs = buildArticlePrompt('compare', PRODUCTS);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/H2\/H3|常见问题/);          // 结构 + schema-friendly
    expect(msgs[1].content).toContain('Cursor');
    expect(msgs[1].content).toContain('对比');                    // 长尾词种子
  });

  it('三个模板角度不同', () => {
    const compare = buildArticlePrompt('compare', PRODUCTS)[1].content;
    const pick = buildArticlePrompt('pick', PRODUCTS)[1].content;
    const guide = buildArticlePrompt('guide', PRODUCTS)[1].content;
    expect(compare).toContain('横评');
    expect(pick).toContain('选型');
    expect(guide).toContain('手册');
  });
});

describe('parseGeneratedArticle', () => {
  it('解析裸 JSON', () => {
    const g = parseGeneratedArticle(JSON.stringify(SAMPLE));
    expect(g.title).toContain('Cursor');
    expect(g.body_html).toContain('<h2>');
  });
  it('剥 ```json 代码块', () => {
    const g = parseGeneratedArticle('```json\n' + JSON.stringify(SAMPLE) + '\n```');
    expect(g.title).toContain('Cursor');
  });
  it('缺 title 抛错', () => {
    expect(() => parseGeneratedArticle(JSON.stringify({ body_html: '<p>x</p>' }))).toThrow();
  });
  it('完全非 JSON 抛错', () => {
    expect(() => parseGeneratedArticle('抱歉无法生成')).toThrow();
  });
});

describe('buildArticleSlug', () => {
  it('产品 slug + 模板后缀,合法 slug', () => {
    expect(buildArticleSlug('compare', PRODUCTS)).toBe('cursor-copilot-compare');
    expect(buildArticleSlug('guide', [PRODUCTS[0]])).toBe('cursor-guide');
  });
});

describe('estimateReadMinutes', () => {
  it('封顶 120,长文不会算出超界值(否则会被 article-validate 1-120 打回)', () => {
    const huge = '<p>' + '字'.repeat(100_000) + '</p>';
    expect(estimateReadMinutes(huge)).toBe(120);
    expect(estimateReadMinutes('<p>短</p>')).toBe(1);
  });
});

describe('generateArticleDraft:超长正文仍能落库(read_minutes 被封顶)', () => {
  it('不因 read_minutes 超界而失败', async () => {
    const longBody = '<h2>很长</h2><p>' + '内容'.repeat(30_000) + '</p>'; // 6 万字 → 估算 150min,需封顶
    const provider = mockProvider({ title: '超长横评', excerpt: '摘要', body_html: longBody });
    const res = await generateArticleDraft([1, 2], 'compare', { sb: fakeSb(PRODUCTS) as never, provider });
    expect(res.ok).toBe(true);
  });
});

describe('generateArticleDraft（3 模板,mock LLM+DB）', () => {
  for (const template of ARTICLE_TEMPLATES) {
    it(`${template}: 产出 draft`, async () => {
      const capture: { row?: Record<string, unknown> } = {};
      const provider = mockProvider(SAMPLE);
      const res = await generateArticleDraft([1, 2], template as ArticleTemplate, {
        sb: fakeSb(PRODUCTS, capture) as never,
        provider,
      });
      expect(res.ok).toBe(true);
      expect(res.article?.status).toBe('draft');                 // 落库为 draft
      expect(res.article?.slug.endsWith(template)).toBe(true);
      expect(String(capture.row?.status)).toBe('draft');
      expect(capture.row?.category).toBeTruthy();                // 有中文分类
      expect(res.meta?.template).toBe(template);
      // prompt 真的拿到了产品数据
      expect(provider.lastMessages?.[1].content).toContain('Cursor');
    });
  }

  it('productIds 为空 → 报错,不调 LLM', async () => {
    const provider = mockProvider(SAMPLE);
    const res = await generateArticleDraft([], 'compare', { sb: fakeSb(PRODUCTS) as never, provider });
    expect(res.ok).toBe(false);
    expect(provider.lastMessages).toBeUndefined();
  });

  it('产品查不到 → 报错', async () => {
    const res = await generateArticleDraft([999], 'compare', {
      sb: fakeSb([]) as never,
      provider: mockProvider(SAMPLE),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未找到');
  });

  // 复审修正 #1:不覆盖已发布
  it('同 slug 已 published → 跳过生成,不覆盖、不调 LLM', async () => {
    const capture: { row?: Record<string, unknown> } = {};
    const provider = mockProvider(SAMPLE);
    const res = await generateArticleDraft([1, 2], 'compare', {
      sb: fakeSb(PRODUCTS, capture, { id: 7, slug: 'cursor-copilot-compare', status: 'published' }) as never,
      provider,
    });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
    expect(provider.lastMessages).toBeUndefined(); // 守卫在 LLM 调用前 → 没调 LLM
    expect(capture.row).toBeUndefined();            // 没写库
  });

  it('同 slug 是 draft → 允许重新生成(刷新草案)', async () => {
    const res = await generateArticleDraft([1, 2], 'compare', {
      sb: fakeSb(PRODUCTS, undefined, { id: 7, slug: 'cursor-copilot-compare', status: 'draft' }) as never,
      provider: mockProvider(SAMPLE),
    });
    expect(res.ok).toBe(true);
    expect(res.article?.status).toBe('draft');
  });

  // 复审修正 #2:落库前消毒
  it('生成的 body_html 含恶意标签 → 落库前被剥离', async () => {
    const capture: { row?: Record<string, unknown> } = {};
    const evil = '<h2>标题</h2><script>steal()</script><img src=x onerror="alert(1)"><p>正文</p>';
    const res = await generateArticleDraft([1, 2], 'compare', {
      sb: fakeSb(PRODUCTS, capture) as never,
      provider: mockProvider({ title: '安全测试', excerpt: '摘要', body_html: evil }),
    });
    expect(res.ok).toBe(true);
    const stored = String(capture.row?.body_html);
    expect(stored).not.toContain('<script');   // 脚本剥离
    expect(stored).not.toContain('onerror');    // 事件属性剥离
    expect(stored).toContain('<h2>');           // 正常排版保留
  });
});
