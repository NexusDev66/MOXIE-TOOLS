import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createProvider, type LlmProvider } from '@/lib/enrichment/provider';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { upsertArticleBySlug, type UpsertArticleResult } from '@/lib/sync/articles';
import { validateArticlePayload, type ArticlePayload } from '@/lib/sync/article-validate';
import {
  buildArticlePrompt,
  parseGeneratedArticle,
  buildArticleSlug,
  getTemplateCategory,
  estimateReadMinutes,
  type ArticleTemplate,
  type ProductForArticle,
} from './templates';
import { sanitizeArticleHtml } from './sanitize';

/**
 * SEO 文章生成核心（T8 AC-2/AC-3）。
 *
 * 读 moxie_products → 按模板组 prompt → 调 LLM → 解析 → 复用 T6 校验 →
 * 以 status='draft' 落 moxie_articles(待 admin 审)。
 *
 * deps 可注入(测试传 mock sb + mock provider);不传则用真实 admin client + env provider。
 */

const PRODUCT_FIELDS = 'slug, name, tagline, description, price_label, tags, domestic_available';

export interface GenerateDeps {
  sb?: SupabaseClient;
  provider?: LlmProvider;
}

export interface GenerateResult {
  ok: boolean;
  error?: string;
  /** 同 slug 已是非 draft(已发布/已编辑)→ 跳过生成,避免覆盖 */
  skipped?: boolean;
  article?: UpsertArticleResult;
  meta?: { provider: string; model: string; tokens: number; cost_usd: number; template: ArticleTemplate };
}

export async function generateArticleDraft(
  productIds: number[],
  template: ArticleTemplate,
  deps: GenerateDeps = {},
): Promise<GenerateResult> {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return { ok: false, error: 'productIds 不能为空' };
  }
  const sb = deps.sb ?? getSupabaseAdminClient();

  // 1. 读产品
  const { data, error } = await sb.from('moxie_products').select(PRODUCT_FIELDS).in('id', productIds);
  if (error) return { ok: false, error: `读取产品失败: ${error.message}` };
  const products = (data ?? []) as ProductForArticle[];
  if (products.length === 0) return { ok: false, error: '未找到对应产品' };

  // 1.5 不覆盖已发布:同 slug 若已存在且非 draft(admin 已发布/已编辑)→ 跳过,
  //     避免生成覆盖人工内容。放在 LLM 调用前,顺便省一次 LLM 成本。
  const slug = buildArticleSlug(template, products);
  const { data: existing } = await sb
    .from('moxie_articles')
    .select('id, status')
    .eq('slug', slug)
    .maybeSingle();
  if (existing && existing.status !== 'draft') {
    return {
      ok: false,
      skipped: true,
      error: `slug "${slug}" 已是 ${existing.status},跳过生成(避免覆盖已发布/已编辑文章;如需重做请人工处理或换 slug)`,
    };
  }

  // 2. 组 prompt → LLM
  let provider: LlmProvider;
  try {
    provider = deps.provider ?? createProvider();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const messages = buildArticlePrompt(template, products);

  let content: string;
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let model = provider.model;
  let cost = 0;
  try {
    const r = await provider.chat(messages, { json: true, maxTokens: 4000 });
    content = r.content;
    usage = r.usage;
    model = r.model;
    cost = r.cost_usd;
  } catch (e) {
    return { ok: false, error: `LLM 调用失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 3. 解析
  let gen;
  try {
    gen = parseGeneratedArticle(content);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 4. 组 payload(draft)→ 落库前服务端消毒 body_html(防存储型 XSS)→ 复用 T6 校验 → 落库
  const safeBody = sanitizeArticleHtml(gen.body_html);
  const payload: ArticlePayload = {
    slug,
    title: gen.title,
    excerpt: gen.excerpt,
    body_html: safeBody,
    category: getTemplateCategory(template),
    read_minutes: estimateReadMinutes(safeBody),
    status: 'draft',
    related_product_ids: productIds,
  };

  const validation = validateArticlePayload(payload);
  if (!validation.ok) {
    return { ok: false, error: `生成内容校验失败 ${validation.error.field}: ${validation.error.message}` };
  }

  try {
    const article = await upsertArticleBySlug(sb, validation.payload);
    return {
      ok: true,
      article,
      meta: {
        provider: provider.name,
        model,
        tokens: usage.prompt_tokens + usage.completion_tokens,
        cost_usd: cost,
        template,
      },
    };
  } catch (e) {
    return { ok: false, error: `落库失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}
