import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ArticlePayload } from './article-validate.js';

/**
 * 把入库 payload 写到 moxie_articles，按 slug 幂等（T6 MOXIE-18）。
 *
 * 语义对齐 T2 products.ts（邓晖 P1 review 后那套）：INSERT / UPDATE 写不同字段集。
 *
 *   - 新 slug → INSERT 全量行：事实字段 + status + published_at
 *   - 同 slug → UPDATE **只更事实字段**（每次 sync 都能提供的）：
 *       title / excerpt / body_html / cover_url / category /
 *       read_minutes / related_product_ids
 *     **绝不触碰**：
 *       status        ← admin 可能已 draft↔published 调过
 *       published_at  ← 首次发布时间，re-sync 不该改
 *       author_id     ← 人工指派
 *
 * moxie_articles 无 updated_at 列，故 UPDATE 不写它。
 */

export interface UpsertArticleResult {
  id: number;
  slug: string;
  status: string;
  inserted: boolean;       // true = 新建; false = 更新已存在的 slug
}

const PG_UNIQUE_VIOLATION = '23505';

/** 事实字段：sync 每次都能从抓取/编辑得到，UPDATE 时刷新 */
function factualFields(payload: ArticlePayload): Record<string, unknown> {
  return {
    title: payload.title,
    excerpt: payload.excerpt ?? null,
    body_html: payload.body_html ?? null,
    cover_url: payload.cover_url ?? null,
    category: payload.category ?? '横评',
    read_minutes: payload.read_minutes ?? 5,
    related_product_ids: payload.related_product_ids ?? [],
  };
}

export async function upsertArticleBySlug(
  sb: SupabaseClient,
  payload: ArticlePayload,
): Promise<UpsertArticleResult> {
  const facts = factualFields(payload);

  // 1. slug 是否已存在
  const { data: existing, error: selErr } = await sb
    .from('moxie_articles')
    .select('id, status')
    .eq('slug', payload.slug)
    .maybeSingle();
  if (selErr) {
    throw new Error(`select-by-slug failed: ${selErr.message}`);
  }

  // 2a. 已存在 → UPDATE 只更事实字段，保留 status / published_at / author_id
  if (existing) {
    return await updateFactual(sb, existing.id as number, facts);
  }

  // 2b. 新 slug → INSERT 全量行
  const status = payload.status ?? 'published';
  // published 文章：published_at = 给定值或 now()；draft：给定值或 null
  const publishedAt =
    payload.published_at ?? (status === 'published' ? new Date().toISOString() : null);

  const { data, error } = await sb
    .from('moxie_articles')
    .insert({ ...facts, slug: payload.slug, status, published_at: publishedAt })
    .select('id, slug, status')
    .single();

  if (error) {
    // TOCTOU：并发同 slug，一个 INSERT 撞 unique → 回落 UPDATE
    if (error.code === PG_UNIQUE_VIOLATION) {
      const { data: raced } = await sb
        .from('moxie_articles')
        .select('id')
        .eq('slug', payload.slug)
        .maybeSingle();
      if (raced) {
        return await updateFactual(sb, raced.id as number, facts);
      }
    }
    throw new Error(`insert failed: ${error.message}`);
  }
  if (!data) throw new Error('insert returned no data');

  return {
    id: data.id as number,
    slug: data.slug as string,
    status: data.status as string,
    inserted: true,
  };
}

async function updateFactual(
  sb: SupabaseClient,
  id: number,
  facts: Record<string, unknown>,
): Promise<UpsertArticleResult> {
  const { data, error } = await sb
    .from('moxie_articles')
    .update(facts)
    .eq('id', id)
    .select('id, slug, status')
    .single();
  if (error || !data) {
    throw new Error(`update failed: ${error?.message ?? 'unknown'}`);
  }
  return {
    id: data.id as number,
    slug: data.slug as string,
    status: data.status as string,
    inserted: false,
  };
}
