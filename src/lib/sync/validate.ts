/**
 * /api/internal/products 入库 payload 校验。
 *
 * 字段对齐 T1 §4.3.1 + moxie_products 表结构，外加 T2 任务概述要求：
 *   - slug         必填，^[a-z0-9-]+$，≤ 60
 *   - name         必填，≤ 60
 *   - domain       必填，≤ 120，做幂等键
 *   - tagline      必填，≤ 30
 *   - description  选填，≤ 1500
 *   - category_slug 选填，要在 moxie_categories.slug 中
 *   - tags         选填，array[string]，≤ 8 项，每项 ≤ 8 字
 *   - price_label  选填，自由文本，≤ 30
 *   - domestic_available 选填，'yes' / 'partial' / 'no'
 *   - data_overseas 选填，boolean
 *   - source       选填，object（溯源元数据，落 audit_log 时记下）
 *
 * 任何字段类型错 / 越界 / 缺失 → ValidationError，caller 转 400
 */

import type { ErrorCode } from './errors.js';

export interface ProductPayload {
  slug: string;
  name: string;
  domain: string;
  tagline: string;
  description?: string;
  category_slug?: string;
  tags?: string[];
  price_label?: string;
  domestic_available?: 'yes' | 'partial' | 'no';
  data_overseas?: boolean;
  source?: Record<string, unknown>;
}

export interface ValidationFailure {
  code: ErrorCode;
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; payload: ProductPayload }
  | { ok: false; error: ValidationFailure };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const DOMESTIC_VALUES = new Set(['yes', 'partial', 'no']);

export function validateProductPayload(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('INVALID_PAYLOAD', '_root', 'request body must be a JSON object');
  }
  const o = raw as Record<string, unknown>;

  // ---- required strings ----
  const slug = checkString(o, 'slug', { required: true, max: 60 });
  if (slug.err) return { ok: false, error: slug.err };
  if (!SLUG_RE.test(slug.value)) {
    return fail('SLUG_FORMAT', 'slug', 'slug must match ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$');
  }

  const name = checkString(o, 'name', { required: true, max: 60 });
  if (name.err) return { ok: false, error: name.err };

  const domain = checkString(o, 'domain', { required: true, max: 120 });
  if (domain.err) return { ok: false, error: domain.err };
  if (!DOMAIN_RE.test(domain.value)) {
    return fail('INVALID_PAYLOAD', 'domain', 'domain must look like example.com');
  }

  const tagline = checkString(o, 'tagline', { required: true, max: 30 });
  if (tagline.err) return { ok: false, error: tagline.err };

  // ---- optional strings ----
  const description = checkString(o, 'description', { required: false, max: 1500 });
  if (description.err) return { ok: false, error: description.err };

  const categorySlug = checkString(o, 'category_slug', { required: false, max: 30 });
  if (categorySlug.err) return { ok: false, error: categorySlug.err };
  if (categorySlug.value && !/^[a-z0-9-]+$/.test(categorySlug.value)) {
    return fail('INVALID_PAYLOAD', 'category_slug', 'category_slug must match [a-z0-9-]+');
  }

  const priceLabel = checkString(o, 'price_label', { required: false, max: 30 });
  if (priceLabel.err) return { ok: false, error: priceLabel.err };

  // ---- enum ----
  let domesticAvailable: 'yes' | 'partial' | 'no' | undefined;
  if (o.domestic_available != null) {
    const v = o.domestic_available;
    if (typeof v !== 'string' || !DOMESTIC_VALUES.has(v)) {
      return fail('INVALID_PAYLOAD', 'domestic_available', 'must be yes/partial/no');
    }
    domesticAvailable = v as 'yes' | 'partial' | 'no';
  }

  // ---- boolean ----
  let dataOverseas: boolean | undefined;
  if (o.data_overseas != null) {
    if (typeof o.data_overseas !== 'boolean') {
      return fail('INVALID_PAYLOAD', 'data_overseas', 'must be boolean');
    }
    dataOverseas = o.data_overseas;
  }

  // ---- array ----
  let tags: string[] | undefined;
  if (o.tags != null) {
    if (!Array.isArray(o.tags)) {
      return fail('INVALID_PAYLOAD', 'tags', 'must be array of strings');
    }
    if (o.tags.length > 8) {
      return fail('INVALID_PAYLOAD', 'tags', 'tags max 8 items');
    }
    const arr: string[] = [];
    for (let i = 0; i < o.tags.length; i++) {
      const t = o.tags[i];
      if (typeof t !== 'string' || !t.trim()) {
        return fail('INVALID_PAYLOAD', `tags[${i}]`, 'each tag must be non-empty string');
      }
      if (t.length > 8) {
        return fail('INVALID_PAYLOAD', `tags[${i}]`, 'each tag must be ≤ 8 chars');
      }
      arr.push(t.trim());
    }
    tags = arr;
  }

  // ---- source (passthrough, validated shallowly) ----
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
      name: name.value,
      domain: domain.value.toLowerCase(),
      tagline: tagline.value,
      ...(description.value ? { description: description.value } : {}),
      ...(categorySlug.value ? { category_slug: categorySlug.value } : {}),
      ...(priceLabel.value ? { price_label: priceLabel.value } : {}),
      ...(domesticAvailable ? { domestic_available: domesticAvailable } : {}),
      ...(dataOverseas !== undefined ? { data_overseas: dataOverseas } : {}),
      ...(tags ? { tags } : {}),
      ...(source ? { source } : {}),
    },
  };
}

// ─── helpers ───

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
      return {
        err: { code: 'INVALID_PAYLOAD', field, message: `${field} is required` },
        value: '',
      };
    }
    return { value: '' };
  }
  if (typeof v !== 'string') {
    return {
      err: { code: 'INVALID_PAYLOAD', field, message: `${field} must be string` },
      value: '',
    };
  }
  const trimmed = v.trim();
  if (opts.required && !trimmed) {
    return {
      err: { code: 'INVALID_PAYLOAD', field, message: `${field} is required` },
      value: '',
    };
  }
  if (trimmed.length > opts.max) {
    return {
      err: {
        code: 'INVALID_PAYLOAD',
        field,
        message: `${field} must be ≤ ${opts.max} chars (got ${trimmed.length})`,
      },
      value: trimmed,
    };
  }
  return { value: trimmed };
}

function fail(code: ErrorCode, field: string, message: string): ValidationResult {
  return { ok: false, error: { code, field, message } };
}
