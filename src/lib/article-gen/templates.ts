/**
 * SEO 文章生成 · prompt 矩阵（T8 MOXIE-21 / AC-1）
 *
 * 3 类模板:横评(compare) / 选型(pick) / 手册(guide)。
 * 每个模板要求 LLM:① 自然嵌入长尾关键词 ② H2/H3 结构(H1=标题单列)
 * ③ schema-friendly 段落(清晰小标题 + 一段 FAQ)。
 *
 * 纯函数、不碰 secret/网络 —— 方便单测(mock provider 后只验组装+解析)。
 */

import type { LlmMessage } from '@/lib/enrichment/provider';

export type ArticleTemplate = 'compare' | 'pick' | 'guide';
export const ARTICLE_TEMPLATES: ArticleTemplate[] = ['compare', 'pick', 'guide'];

/** 喂给 prompt 的产品精简数据 */
export interface ProductForArticle {
  slug: string;
  name: string;
  tagline: string;
  description: string | null;
  price_label: string | null;
  tags: string[] | null;
  domestic_available: string | null;
}

export interface GeneratedArticle {
  title: string;
  excerpt: string;
  body_html: string;
}

interface TemplateMeta {
  /** 落库的中文分类名 */
  category: string;
  /** slug 的英文后缀 */
  slugSuffix: string;
  /** 这类文章的写作角度(进 prompt) */
  angle: string;
}

const META: Record<ArticleTemplate, TemplateMeta> = {
  compare: {
    category: '横评',
    slugSuffix: 'compare',
    angle:
      '横向对比这几款工具:逐项对比核心功能、价格、上手难度、国内可用性,给出"谁更适合谁"的结论,带一个对比小结。',
  },
  pick: {
    category: '选型',
    slugSuffix: 'pick',
    angle:
      '选型指南:按不同人群/预算/场景,告诉读者该选哪一款,给清晰的决策建议(如"预算有限选 X、团队协作选 Y")。',
  },
  guide: {
    category: '手册',
    slugSuffix: 'guide',
    angle:
      '上手手册:围绕这些工具讲怎么用、典型工作流、常见坑与最佳实践,偏实操 how-to。',
  },
};

/** 由产品名 + 模板角度派生几个长尾关键词种子,提示 LLM 自然嵌入 */
function longtailSeeds(template: ArticleTemplate, products: ProductForArticle[]): string[] {
  const names = products.map((p) => p.name);
  const joined = names.join(' vs ');
  switch (template) {
    case 'compare':
      return [`${joined} 对比`, `${names[0]} 和 ${names[1] ?? '替代品'} 哪个好`, `${names[0]} 平替`];
    case 'pick':
      return [`${names[0]} 怎么选`, `${names[0]} 值得买吗`, `${names[0]} 适合谁`];
    case 'guide':
      return [`${names[0]} 怎么用`, `${names[0]} 教程`, `${names[0]} 使用技巧`];
  }
}

export function getTemplateCategory(template: ArticleTemplate): string {
  return META[template].category;
}

/** 生成文章 slug:产品 slug(最多 3 个) + 模板后缀,清洗成 [a-z0-9-] ≤ 80 */
export function buildArticleSlug(template: ArticleTemplate, products: ProductForArticle[]): string {
  const base = products
    .slice(0, 3)
    .map((p) => p.slug)
    .join('-');
  const slug = `${base}-${META[template].slugSuffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || `ai-tools-${META[template].slugSuffix}`;
}

const SYSTEM_PROMPT = `你是中文 SEO 内容编辑,为「AI 工具导航站」写长文。要求:

1. **只依据给定的产品资料**,不编造不存在的功能/价格/数据。
2. **长尾关键词**:自然嵌入给定的长尾关键词(标题、小标题、首段各覆盖到),不堆砌。
3. **结构**:正文用 H2/H3 分节(<h2>/<h3>),不要再出 <h1>(标题单独给)。每节有清晰小标题,段落用 <p>。结尾带一个「常见问题」H2,下面 2-3 组问答(<h3>问题</h3><p>答案</p>),利于 schema 抓取。
4. **正文格式**:输出干净的 HTML 片段(只用 h2/h3/p/ul/li/strong),不要 <html>/<body>/markdown 代码块。
5. **篇幅**:正文 800-1500 字,信息密度高、客观、不夸张。

只输出一个 JSON 对象,字段:
  - title:     文章标题,≤ 40 字,含主关键词
  - excerpt:   摘要,≤ 100 字
  - body_html: 正文 HTML 片段(不含 h1)
不要输出 JSON 以外的任何内容。`;

/** 组装发给 LLM 的 messages */
export function buildArticlePrompt(template: ArticleTemplate, products: ProductForArticle[]): LlmMessage[] {
  const meta = META[template];
  const seeds = longtailSeeds(template, products);
  const productBlock = products
    .map(
      (p, i) =>
        `${i + 1}. ${p.name}（${p.slug}）\n   一句话:${p.tagline}\n   介绍:${p.description ?? '（无）'}\n   价格:${p.price_label ?? '不详'}　国内可用:${p.domestic_available ?? '不详'}　标签:${(p.tags ?? []).join('/') || '无'}`,
    )
    .join('\n');

  const user = `文章类型:${meta.category}
写作角度:${meta.angle}

需要自然嵌入的长尾关键词:
${seeds.map((s) => `- ${s}`).join('\n')}

产品资料:
${productBlock}

按系统要求输出 JSON。`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function extractJsonObject(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  return s;
}

/**
 * 解析 LLM 返回 → GeneratedArticle。容错:剥代码块、缺字段报错、长度兜底。
 * @throws 完全 parse 不出 JSON 或缺 title/body 时
 */
export function parseGeneratedArticle(content: string): GeneratedArticle {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(extractJsonObject(content));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object');
    obj = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`LLM 输出不是合法 JSON: ${content.slice(0, 120)}`);
  }

  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const body = typeof obj.body_html === 'string' ? obj.body_html.trim() : '';
  if (!title) throw new Error('LLM 输出缺 title');
  if (!body) throw new Error('LLM 输出缺 body_html');
  const excerpt = typeof obj.excerpt === 'string' ? obj.excerpt.trim() : '';

  return {
    title: title.slice(0, 120),
    excerpt: (excerpt || title).slice(0, 300),
    body_html: body,
  };
}

/** 粗估阅读时长(分钟):按中文 ~400 字/分钟,去标签后算。封顶 120(对齐 article-validate 的 1-120 约束) */
export function estimateReadMinutes(bodyHtml: string): number {
  const text = bodyHtml.replace(/<[^>]+>/g, '');
  return Math.min(120, Math.max(1, Math.round(text.length / 400)));
}
