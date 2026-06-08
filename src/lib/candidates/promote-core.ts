import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { upsertProductByDomain, loadCategoryMap } from '@/lib/sync/products';
import type { ProductPayload } from '@/lib/sync/validate';
import { enqueueCategoryRoundup } from '@/lib/triggers/article-enqueue';

/**
 * promote 核心机制（T11 MOXIE-24）—— 人工(admin action)与自动(cron)共用。
 *
 * 只做「升级机制」:分类校验 → upsert 产品 → 带入封面 → candidate 标 promoted →
 * T10 事件驱动入队。**不做** auth / audit(各调用方按自身上下文处理)。
 *
 * 从 admin actions.ts 抽出,避免人工/自动两条路逻辑分叉(尤其 T10 文章入队联动)。
 */

export interface ExecutePromoteResult {
  ok: boolean;
  productId?: number;
  inserted?: boolean;
  /** 分类不存在 / 内部错误 */
  errorCode?: 'UNKNOWN_CATEGORY_SLUG' | 'INTERNAL_ERROR';
  error?: string;
  /** 产品已写入,但 candidate 状态同步失败(需 caller 提示) */
  candidateSyncError?: string;
  /** domain 已存在且 onExistingDomain='link' → 仅链接现有产品,未覆盖任何事实字段 */
  linkedExisting?: boolean;
}

export interface ExecutePromoteParams {
  candidateId: number;
  /** 已通过 validateProductPayload 的 payload */
  payload: ProductPayload;
  /** 预加载的 category map;不传则内部 loadCategoryMap */
  categoryMap?: Map<string, number>;
  /**
   * domain 已存在时的策略:
   *  - 'update'(默认,人工 promote):走 upsert 的 UPDATE 路径,用 payload 事实字段刷新(admin 有意覆盖)
   *  - 'link'(自动 promote / 再次校验):**不覆盖**现有产品,只把候选标 promoted + 链接现有产品。
   *    自动派生的 payload 无 category_slug、内容是 AI 猜的,覆盖会清掉人工类目/已发布内容。
   */
  onExistingDomain?: 'update' | 'link';
}

export async function executePromote(
  sb: SupabaseClient,
  params: ExecutePromoteParams,
): Promise<ExecutePromoteResult> {
  const { candidateId, payload } = params;
  const categoryMap = params.categoryMap ?? (await loadCategoryMap(sb));

  // 分类存在性
  if (payload.category_slug && !categoryMap.has(payload.category_slug)) {
    return { ok: false, errorCode: 'UNKNOWN_CATEGORY_SLUG', error: `分类 "${payload.category_slug}" 不存在` };
  }

  // 自动升级('link'):domain 已存在则**不覆盖**现有产品(自动 payload 无类目、内容 AI 猜,
  // upsert 的 UPDATE 路径会清零 category_id + 覆盖人工内容)。只标候选 promoted + 链接现有产品。
  if ((params.onExistingDomain ?? 'update') === 'link') {
    const { data: existing, error: selErr } = await sb
      .from('moxie_products')
      .select('id')
      .eq('domain', payload.domain)
      .maybeSingle();
    if (selErr) {
      return { ok: false, errorCode: 'INTERNAL_ERROR', error: `查 domain 失败: ${selErr.message}` };
    }
    if (existing) {
      const existingId = (existing as { id: number }).id;
      const { error: candErr } = await sb
        .from('moxie_trend_candidates')
        .update({ status: 'promoted', promoted_product_id: existingId, promoted_at: new Date().toISOString() })
        .eq('id', candidateId);
      return {
        ok: true,
        productId: existingId,
        inserted: false,
        linkedExisting: true,
        ...(candErr ? { candidateSyncError: candErr.message } : {}),
      };
    }
    // 不存在 → 落到下面 upsert,走 INSERT 新建(不会 UPDATE 覆盖)
  }

  // upsert 产品(复用 T2)
  let result;
  try {
    result = await upsertProductByDomain(sb, payload, { categoryIdBySlug: categoryMap });
  } catch (e) {
    return { ok: false, errorCode: 'INTERNAL_ERROR', error: e instanceof Error ? e.message : String(e) };
  }

  // T9: 候选若已截图 → 带入产品 cover_url(best-effort,仅新建时,不覆盖已有封面)
  if (result.inserted) {
    try {
      const { data: candRow } = await sb
        .from('moxie_trend_candidates')
        .select('screenshot_url')
        .eq('id', candidateId)
        .maybeSingle();
      const shot = (candRow as { screenshot_url?: string | null } | null)?.screenshot_url;
      if (shot) {
        await sb.from('moxie_products').update({ cover_url: shot }).eq('id', result.id);
      }
    } catch (e) {
      console.error('[promote-core] 带入封面失败(忽略)', e instanceof Error ? e.message : e);
    }
  }

  // candidate status pending → promoted
  const { error: candErr } = await sb
    .from('moxie_trend_candidates')
    .update({
      status: 'promoted',
      promoted_product_id: result.id,
      promoted_at: new Date().toISOString(),
    })
    .eq('id', candidateId);

  // T10 事件驱动:promote 成功 → 看该类目本周是否达阈值 → 入队横评(best-effort)
  if (payload.category_slug) {
    const categoryId = categoryMap.get(payload.category_slug);
    if (categoryId != null) {
      try {
        await enqueueCategoryRoundup(sb, { categoryId, categorySlug: payload.category_slug });
      } catch (e) {
        console.error('[promote-core] enqueueCategoryRoundup 失败(忽略)', e instanceof Error ? e.message : e);
      }
    }
  }

  return {
    ok: true,
    productId: result.id,
    inserted: result.inserted,
    ...(candErr ? { candidateSyncError: candErr.message } : {}),
  };
}
