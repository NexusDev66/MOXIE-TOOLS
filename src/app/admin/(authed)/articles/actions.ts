'use server';

import { getCurrentAdmin } from '@/lib/admin/auth';
import { generateArticleDraft, type GenerateResult } from '@/lib/article-gen/generate';
import type { ArticleTemplate } from '@/lib/article-gen/templates';

/**
 * 服务端动作（T8 MOXIE-21 / AC-2）:
 *   admin 选若干产品 + 模板(横评/选型/手册)→ LLM 生成 SEO 长文 → 落 moxie_articles draft。
 *
 * 仅 admin 可调；核心逻辑在 @/lib/article-gen/generate(可单测、deps 可注入)。
 * v0 不带 UI(AC 未要求),此 action 供后续 admin 页面 / 脚本调用。
 */
export async function generateArticleFromProducts(
  productIds: number[],
  template: ArticleTemplate,
): Promise<GenerateResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: '无权限（需要 admin）' };
  return generateArticleDraft(productIds, template);
}
