/**
 * POST /api/internal/articles 入库 payload 校验（T6 MOXIE-18）。
 *
 * 字段对齐 moxie_articles 表（migration_001）+ T6 任务概述：
 *   - slug          必填，^[a-z0-9-]+$，≤ 80，**幂等键**
 *   - title         必填，≤ 120
 *   - excerpt       选填，≤ 300
 *   - body_html     选填，≤ 100000（富文本 HTML；内图后续 import 到 Storage）
 *   - cover_url     选填，http(s) URL，≤ 500
 *   - category      选填，≤ 20（横评/手册/增长/选型，自由文本）
 *   - read_minutes  选填，int 1–120
 *   - status        选填，'draft' | 'published'（默认 published）
 *   - published_at  选填，ISO 时间串（不填且 published → 服务端 now()）
 *   - related_product_ids 选填，正整数数组，≤ 50
 *   - source        选填，object（溯源元数据，落 audit_log）
 *
 * 复用 T2 的 ErrorCode；校验风格对齐 src/lib/sync/validate.ts。
 */

import type { ErrorCode } from './errors.js';

export type ArticleStatus = 'draft' | 'published';

export interface ArticlePayload {
  slug: string;
  title: string;
  excerpt?: string;
  body_html?: string;
  cover_url?: string;
  category?: string;
  read_minutes?: number;
  status?: ArticleStatus;
  published_at?: string;
  related_product_ids?: number[];
  source?: Record<string, unknown>;
}

export interface ValidationFailure {
  code: ErrorCode;
  field: string;
  message: string;
}

export type ArticleValidationResult =
  | { ok: true; payload: ArticlePayload }
  | { ok: false; error: ValidationFailure };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const STATUS_VALUES = new Set<ArticleStatus>(['draft', 'published']);
const MAX_BODY = 100_000;

export function validateArticlePayload(raw: unknown): ArticleValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('INVALID_PAYLOAD', '_root', 'request body must be a JSON object');
  }
  const o = raw as Record<string, unknown>;

  // ---- required ----
  const slug = checkString(o, 'slug', { required: true, max: 80 });
  if (slug.err) return { ok: false, error: slug.err };
  if (!SLUG_RE.test(slug.value)) {
    return fail('SLUG_FORMAT', 'slug', 'slug must match ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$');
  }

  const title = checkString(o, 'title', { required: true, max: 120 });
  if (title.err) return { ok: false, error: title.err };

  // ---- optional strings ----
  const excerpt = checkString(o, 'excerpt', { required: false, max: 300 });
  if (excerpt.err) return { ok: false, error: excerpt.err };

  const bodyHtml = checkString(o, 'body_html', { required: false, max: MAX_BODY });
  if (bodyHtml.err) return { ok: false, error: bodyHtml.err };

  const coverUrl = checkString(o, 'cover_url', { required: false, max: 500 });
  if (coverUrl.err) return { ok: false, error: coverUrl.err };
  if (coverUrl.value && !/^https?:\/\//i.test(coverUrl.value)) {
    return fail('INVALID_PAYLOAD', 'cover_url', 'cover_url must be an http(s) URL');
  }

  const category = checkString(o, 'category', { required: false, max: 20 });
  if (category.err) return { ok: false, error: category.err };

  // ---- read_minutes: int 1–120 ----
  let readMinutes: number | undefined;
  if (o.read_minutes != null) {
    const v = o.read_minutes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 120) {
      return fail('INVALID_PAYLOAD', 'read_minutes', 'read_minutes must be an integer 1–120');
    }
    readMinutes = v;
  }

  // ---- status enum ----
  let status: ArticleStatus | undefined;
  if (o.status != null) {
    const v = o.status;
    if (typeof v !== 'string' || !STATUS_VALUES.has(v as ArticleStatus)) {
      return fail('INVALID_PAYLOAD', 'status', 'status must be draft or published');
    }
    status = v as ArticleStatus;
  }

  // ---- published_at: ISO 时间串 ----
  let publishedAt: string | undefined;
  if (o.published_at != null) {
    const v = o.published_at;
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
      return fail('INVALID_PAYLOAD', 'published_at', 'published_at must be an ISO date string');
    }
    publishedAt = new Date(v).toISOString();
  }

  // ---- related_product_ids: 正整数数组 ≤ 50 ----
  let relatedIds: number[] | undefined;
  if (o.related_product_ids != null) {
    if (!Array.isArray(o.related_product_ids)) {
      return fail('INVALID_PAYLOAD', 'related_product_ids', 'must be array of positive integers');
    }
    if (o.related_product_ids.length > 50) {
      return fail('INVALID_PAYLOAD', 'related_product_ids', 'max 50 items');
    }
    const arr: number[] = [];
    for (let i = 0; i < o.related_product_ids.length; i++) {
      const n = o.related_product_ids[i];
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
        return fail('INVALID_PAYLOAD', `related_product_ids[${i}]`, 'each must be a positive integer');
      }
      arr.push(n);
    }
    relatedIds = arr;
  }

  // ---- source passthrough ----
  let source: Record<string, unknown> | undefined;
  if (o.source != null) {
    if (typeof o.source !== 'object' || Array.isArray(o.source)) {
      return fail('INVALID_PAYLOAD', 'source', 'source must be a JSON object');
    }
    source = o.source as Record<string, unknown>;
  }

  return {
    ok: true,
    payload: {
      slug: slug.value,
      title: title.value,
      ...(excerpt.value ? { excerpt: excerpt.value } : {}),
      ...(bodyHtml.value ? { body_html: bodyHtml.value } : {}),
      ...(coverUrl.value ? { cover_url: coverUrl.value } : {}),
      ...(category.value ? { category: category.value } : {}),
      ...(readMinutes !== undefined ? { read_minutes: readMinutes } : {}),
      ...(status ? { status } : {}),
      ...(publishedAt ? { published_at: publishedAt } : {}),
      ...(relatedIds ? { related_product_ids: relatedIds } : {}),
      ...(source ? { source } : {}),
    },
  };
}

// ─── helpers（对齐 validate.ts 风格） ───

interface CheckStringOpts {
  required: boolean;
  max: number;
}
interface CheckStringOk {
  err?: undefined;
  value: string;
}
interface CheckStringFail {
  err: ValidationFailure;
  value: string;
}

function checkString(
  o: Record<string, unknown>,
  field: string,
  opts: CheckStringOpts,
): CheckStringOk | CheckStringFail {
  const v = o[field];
  if (v == null || v === '') {
    if (opts.required) {
      return { err: { code: 'INVALID_PAYLOAD', field, message: `${field} is required` }, value: '' };
    }
    return { value: '' };
  }
  if (typeof v !== 'string') {
    return { err: { code: 'INVALID_PAYLOAD', field, message: `${field} must be string` }, value: '' };
  }
  const trimmed = v.trim();
  if (opts.required && !trimmed) {
    return { err: { code: 'INVALID_PAYLOAD', field, message: `${field} is required` }, value: '' };
  }
  if (trimmed.length > opts.max) {
    return {
      err: { code: 'INVALID_PAYLOAD', field, message: `${field} must be ≤ ${opts.max} chars (got ${trimmed.length})` },
      value: trimmed,
    };
  }
  return { value: trimmed };
}

function fail(code: ErrorCode, field: string, message: string): ArticleValidationResult {
  return { ok: false, error: { code, field, message } };
}
