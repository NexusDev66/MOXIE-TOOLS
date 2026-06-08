'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentAdmin } from '@/lib/admin/auth';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { validateProductPayload } from '@/lib/sync/validate';
import { writeAuditLog } from '@/lib/sync/audit';
import { fetchProductHtml, enrichProduct, type EnrichMeta } from '@/lib/enrichment/enrich';
import type { AiEnrichment } from '@/lib/enrichment/prompt';
import { captureAndStoreCover, type CoverSource } from '@/lib/screenshot/landing';
import { executePromote } from '@/lib/candidates/promote-core';
import { scoreCandidate } from '@/lib/scoring/completeness';
import { buildAutoPromotePayload, autoPromoteThreshold, type AutoPromoteCandidate } from '@/lib/candidates/auto-promote';

/**
 * 升级（promote）一个 candidate 到 moxie_products。
 *
 * 设计决定（待邓晖确认）：**直接函数调用** T2 的 upsertProductByDomain，
 * 不走 HTTP 自调 /api/internal/products —— 同 app 内自调 HTTP 绕 token 浪费。
 * 复用 T2 的 validate / products / audit lib，只跳过 Bearer token 层
 * （admin 已经 Supabase 登录鉴权）。
 *
 * 流程:
 *   1. requireAdmin()（非 admin throw → server action 拒绝）
 *   2. validateProductPayload（复用 T2 校验）
 *   3. category_slug 存在性校验
 *   4. upsertProductByDomain（复用 T2，status=pending）
 *   5. candidate status pending → promoted + promoted_product_id
 *   6. 写 audit_log（source='admin_ui'）
 */

export interface PromoteState {
  ok?: boolean;
  error?: string;
  message?: string;
}

async function requireAdmin() {
  const admin = await getCurrentAdmin();
  if (!admin) throw new Error('Unauthorized');
  return admin;
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export async function promoteCandidate(
  candidateId: number,
  _prev: PromoteState,
  formData: FormData,
): Promise<PromoteState> {
  const startedAt = Date.now();
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { ok: false, error: '无权限（需要 admin）' };
  }

  const payloadRaw = {
    slug: String(formData.get('slug') ?? '').trim(),
    name: String(formData.get('name') ?? '').trim(),
    domain: String(formData.get('domain') ?? '').trim(),
    tagline: String(formData.get('tagline') ?? '').trim(),
    description: String(formData.get('description') ?? '').trim() || undefined,
    category_slug: String(formData.get('category_slug') ?? '').trim() || undefined,
    tags: parseTags(String(formData.get('tags') ?? '')),
    price_label: String(formData.get('price_label') ?? '').trim() || undefined,
    domestic_available: String(formData.get('domestic_available') ?? '').trim() || undefined,
  };

  // 复用 T2 的校验
  const validation = validateProductPayload(payloadRaw);
  if (!validation.ok) {
    return {
      ok: false,
      error: `${validation.error.field}: ${validation.error.message}`,
    };
  }
  const payload = validation.payload;

  const sb = getSupabaseAdminClient();
  let httpStatus = 200;
  let errorCode: string | null = null;
  let productId: number | null = null;

  try {
    // 升级机制复用 promote-core(人工/自动同一条路;含封面带入 + T10 入队)
    const result = await executePromote(sb, { candidateId, payload });

    if (!result.ok) {
      errorCode = result.errorCode ?? 'INTERNAL_ERROR';
      httpStatus = result.errorCode === 'UNKNOWN_CATEGORY_SLUG' ? 400 : 500;
      return { ok: false, error: result.error ?? '升级失败' };
    }

    productId = result.productId ?? null;
    httpStatus = result.inserted ? 201 : 200;

    revalidatePath('/admin/candidates');

    // 产品已写入，但 candidate 状态同步失败 → admin 需要知道，不能按完全成功返回
    if (result.candidateSyncError) {
      console.error('[promote] candidate status update failed', result.candidateSyncError);
      return {
        ok: true,
        message: `⚠️ 产品 #${result.productId} 已写入（${result.inserted ? '新建' : '更新'}），但 candidate 状态未同步（${result.candidateSyncError}）。请刷新；如仍在 pending 列表请联系 dev 手动改 candidate.status='promoted'。`,
      };
    }

    return {
      ok: true,
      message: `已升级 → 产品 #${result.productId}（${result.inserted ? '新建' : '更新已存在 domain'}），candidate 标记 promoted`,
    };
  } catch (e) {
    errorCode = 'INTERNAL_ERROR';
    httpStatus = 500;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[promote] failed', msg);
    return { ok: false, error: `升级失败: ${msg}` };
  } finally {
    await writeAuditLog(sb, {
      source: 'admin_ui',
      endpoint: '/admin/candidates/promote',
      httpMethod: 'POST',
      httpStatus,
      targetType: 'product',
      targetId: productId,
      targetNaturalKey: payload.domain,
      tokenFingerprint: null,
      payloadRaw: JSON.stringify({ candidateId, by: admin.userId }),
      payloadBytes: null,
      latencyMs: Date.now() - startedAt,
      errorCode,
      errorMessage: null,
      requestId: null,
      userAgent: 'admin-ui',
    }).catch(() => undefined);
  }
}

export interface RecheckState {
  ok?: boolean;
  score?: number;
  promoted?: boolean;
  message?: string;
  error?: string;
}

const RECHECK_FIELDS =
  'id, status, tool_name_hint, tool_domain, tool_url, occurrence_count, ai_enrichment_jsonb, screenshot_url';

/**
 * 「再次校验」(T11 MOXIE-24 / AC-4):重算单条候选完善度,达阈值即自动升级。
 * 给 admin 一个手动触发自动 promote 检查的入口(不必等每日 cron)。复用 auto-promote 同一套逻辑。
 */
export async function recheckCandidate(
  candidateId: number,
  _prev: RecheckState,
  _formData: FormData,
): Promise<RecheckState> {
  const startedAt = Date.now();
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { ok: false, error: '无权限（需要 admin）' };
  }

  const sb = getSupabaseAdminClient();
  const { data: cand, error } = await sb
    .from('moxie_trend_candidates')
    .select(RECHECK_FIELDS)
    .eq('id', candidateId)
    .maybeSingle();
  if (error || !cand) {
    return { ok: false, error: `候选不存在或读取失败: ${error?.message ?? 'not found'}` };
  }
  if ((cand as { status?: string }).status !== 'pending') {
    return { ok: false, error: '该候选已不是 pending(可能已升级/已跳过)' };
  }

  const c = cand as unknown as AutoPromoteCandidate;
  const { score, missing } = scoreCandidate(c);
  const threshold = autoPromoteThreshold();

  if (score < threshold) {
    return {
      ok: true,
      score,
      promoted: false,
      message: `完善度 ${score}/${threshold},未达阈值${missing.length ? `（缺：${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}）` : ''}`,
    };
  }

  const built = buildAutoPromotePayload(c);
  if (!built.ok) {
    return { ok: false, score, error: `达阈值但无法拼 payload：${built.reason}` };
  }
  const validation = validateProductPayload(built.payload);
  if (!validation.ok) {
    return { ok: false, score, error: `达阈值但 payload 校验失败 ${validation.error.field}: ${validation.error.message}` };
  }

  // onExistingDomain='link':domain 已存在则只链接、不覆盖人工维护的产品(复审 #13)
  const res = await executePromote(sb, { candidateId, payload: validation.payload, onExistingDomain: 'link' });
  revalidatePath('/admin/candidates');

  // 审计:recheck 触发的自动升级也要留痕(对齐人工 promote / cron auto-promote)
  await writeAuditLog(sb, {
    source: 'admin_ui',
    endpoint: '/admin/candidates/recheck',
    httpMethod: 'POST',
    httpStatus: res.ok ? (res.inserted ? 201 : 200) : 500,
    targetType: 'product',
    targetId: res.productId ?? null,
    targetNaturalKey: built.payload.domain,
    tokenFingerprint: null,
    payloadRaw: JSON.stringify({ candidateId, score, by: admin.userId, auto: true }),
    payloadBytes: null,
    latencyMs: Date.now() - startedAt,
    errorCode: res.ok ? null : 'INTERNAL_ERROR',
    errorMessage: null,
    requestId: null,
    userAgent: 'admin-ui',
  }).catch(() => undefined);

  if (!res.ok) {
    return { ok: false, score, error: `自动升级失败：${res.error}` };
  }
  return {
    ok: true,
    score,
    promoted: true,
    message: res.linkedExisting
      ? `完善度 ${score} ≥ ${threshold}，该域名已有产品 #${res.productId}，已链接(未覆盖人工内容)`
      : `完善度 ${score} ≥ ${threshold}，已自动升级 → 产品 #${res.productId}`,
  };
}

/** 跳过某 candidate（status pending → dismissed） */
export async function dismissCandidate(
  candidateId: number,
  _prev: PromoteState,
  formData: FormData,
): Promise<PromoteState> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false, error: '无权限（需要 admin）' };
  }
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300);
  const sb = getSupabaseAdminClient();
  const { error } = await sb
    .from('moxie_trend_candidates')
    .update({ status: 'dismissed', dismissed_reason: reason || 'admin dismissed' })
    .eq('id', candidateId);
  if (error) return { ok: false, error: `跳过失败: ${error.message}` };
  revalidatePath('/admin/candidates');
  return { ok: true, message: '已跳过' };
}

/**
 * AI 一键补全（T5 AC-4）：拉候选官网 HTML → LLM 抽 5 字段 → 写 ai_enrichment_jsonb。
 *
 * 流程:
 *   1. requireAdmin
 *   2. 查 candidate 拿 tool_url / name（不信前端传入）
 *   3. fetchProductHtml → enrichProduct（provider 按 env，默认 deepseek）
 *   4. 写 ai_enrichment_jsonb + ai_enriched_at
 *   5. 写 audit_log，返回补全结果给前端展示 + 采纳
 *
 * 不在这里采纳到 moxie_products —— 采纳是 admin 看过后在升级表单里点。
 */
export interface EnrichState {
  ok?: boolean;
  error?: string;
  enrichment?: AiEnrichment;
  meta?: EnrichMeta;
}

export async function enrichCandidate(
  candidateId: number,
  _prev: EnrichState,
  _formData: FormData,
): Promise<EnrichState> {
  const startedAt = Date.now();
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { ok: false, error: '无权限（需要 admin）' };
  }

  const sb = getSupabaseAdminClient();
  let httpStatus = 200;
  let errorCode: string | null = null;

  // 查 candidate（服务端取 url/name，不信前端）
  const { data: cand, error: candErr } = await sb
    .from('moxie_trend_candidates')
    .select('id, tool_url, tool_domain, tool_name_hint')
    .eq('id', candidateId)
    .maybeSingle();
  if (candErr || !cand) {
    return { ok: false, error: `候选不存在或读取失败: ${candErr?.message ?? 'not found'}` };
  }

  const name = (cand.tool_name_hint as string | null) ?? (cand.tool_domain as string);
  const url = cand.tool_url as string;

  try {
    const html = await fetchProductHtml(url);
    const { enrichment, _meta } = await enrichProduct({ name, url, html });

    const { error: upErr } = await sb
      .from('moxie_trend_candidates')
      .update({
        ai_enrichment_jsonb: { ...enrichment, _meta },
        ai_enriched_at: _meta.enriched_at,
      })
      .eq('id', candidateId);
    if (upErr) {
      errorCode = 'DB_WRITE_FAILED';
      httpStatus = 500;
      return { ok: false, error: `补全已生成但写库失败: ${upErr.message}` };
    }

    revalidatePath('/admin/candidates');
    return { ok: true, enrichment, meta: _meta };
  } catch (e) {
    errorCode = 'ENRICH_FAILED';
    httpStatus = 502;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[enrich] failed', msg);
    return { ok: false, error: `AI 补全失败: ${msg}` };
  } finally {
    await writeAuditLog(sb, {
      source: 'admin_ui',
      endpoint: '/admin/candidates/enrich',
      httpMethod: 'POST',
      httpStatus,
      targetType: 'candidate',
      targetId: candidateId,
      targetNaturalKey: url,
      tokenFingerprint: null,
      payloadRaw: JSON.stringify({ candidateId, by: admin.userId }),
      payloadBytes: null,
      latencyMs: Date.now() - startedAt,
      errorCode,
      errorMessage: null,
      requestId: null,
      userAgent: 'admin-ui',
    }).catch(() => undefined);
  }
}

/**
 * 自动配图（T9 AC-3）：Playwright 截候选官网首屏(截不到则兜底 OG/favicon)→
 * 传 moxie-covers → 写 candidate.screenshot_url。升级该候选时由 promoteCandidate
 * 带入 product.cover_url。
 *
 * 截图实现见 @/lib/screenshot/landing(Playwright 可注入,单测 mock)。
 * 真实截图的 serverless 适配(@sparticuz/chromium)待部署阶段,见任务说明。
 */
export interface CoverState {
  ok?: boolean;
  error?: string;
  coverUrl?: string;
  source?: CoverSource;
  message?: string;
}

/** 由域名派生存储路径用的 slug:cursor.com → cursor-com */
function slugFromDomain(domain: string): string {
  return (
    domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'product'
  );
}

export async function captureCandidateCover(
  candidateId: number,
  _prev: CoverState,
  _formData: FormData,
): Promise<CoverState> {
  const startedAt = Date.now();
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { ok: false, error: '无权限（需要 admin）' };
  }

  const sb = getSupabaseAdminClient();
  let httpStatus = 200;
  let errorCode: string | null = null;
  let url: string | null = null;

  try {
    const { data: cand, error: candErr } = await sb
      .from('moxie_trend_candidates')
      .select('id, tool_url, tool_domain')
      .eq('id', candidateId)
      .maybeSingle();
    if (candErr || !cand) {
      errorCode = 'NOT_FOUND';
      httpStatus = 404;
      return { ok: false, error: `候选不存在或读取失败: ${candErr?.message ?? 'not found'}` };
    }

    url = cand.tool_url as string;
    const slug = slugFromDomain(cand.tool_domain as string);

    const result = await captureAndStoreCover(sb, { slug, url });
    if (!result.coverUrl) {
      errorCode = 'CAPTURE_FAILED';
      httpStatus = 502;
      return { ok: false, error: result.error ?? '截图失败' };
    }

    const { error: upErr } = await sb
      .from('moxie_trend_candidates')
      .update({ screenshot_url: result.coverUrl })
      .eq('id', candidateId);
    if (upErr) {
      errorCode = 'DB_WRITE_FAILED';
      httpStatus = 500;
      return { ok: false, error: `截图已生成但写库失败: ${upErr.message}` };
    }

    revalidatePath('/admin/candidates');
    return {
      ok: true,
      coverUrl: result.coverUrl,
      source: result.source,
      message: `已截图（来源:${result.source}）,升级时将带入产品封面`,
    };
  } finally {
    await writeAuditLog(sb, {
      source: 'admin_ui',
      endpoint: '/admin/candidates/cover',
      httpMethod: 'POST',
      httpStatus,
      targetType: 'candidate',
      targetId: candidateId,
      targetNaturalKey: url,
      tokenFingerprint: null,
      payloadRaw: JSON.stringify({ candidateId, by: admin.userId }),
      payloadBytes: null,
      latencyMs: Date.now() - startedAt,
      errorCode,
      errorMessage: null,
      requestId: null,
      userAgent: 'admin-ui',
    }).catch(() => undefined);
  }
}
