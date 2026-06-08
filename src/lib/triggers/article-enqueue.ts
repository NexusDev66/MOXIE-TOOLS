import type { SupabaseClient } from '@supabase/supabase-js';
import type { ArticleTemplate } from '@/lib/article-gen/templates';

/**
 * 文章生成触发器 · enqueue 逻辑（T10 MOXIE-23 / AC-1）
 *
 * 两路把任务写进 moxie_article_jobs:
 *   (1) enqueueCategoryRoundup —— 事件驱动:某 category 本周新增产品 >= N → 横评(compare)
 *   (2) enqueueWeeklyTrend     —— 定时:本周 high-value(featured/verified)产品 → 选型(pick)趋势文
 *
 * 设计决定(待邓晖确认):事件驱动按 **moxie_products.category_id** 统计,不按 trend_candidates。
 *   原因:candidates 表无类目列(类目是 promote 后才写到 products);且「横评」本就针对成品工具。
 *   口径可逆——若要改回 candidates 维度,只动本文件。见 docs/article-triggers.md。
 *
 * 纯逻辑 + 注入 sb(不 import server-only),便于单测:mock sb 即可验阈值/去重/payload。
 */

export type ArticleJobType = 'category_roundup' | 'weekly_trend';

export interface ArticleJobPayload {
  template: ArticleTemplate;
  product_ids: number[];
  category_id?: number | null;
  category_slug?: string | null;
  reason?: string;
}

export interface EnqueueResult {
  enqueued: boolean;
  /** 人类可读说明:入队成功 / 未达阈值 / 本周已入队 / 无产品 */
  reason: string;
  jobId?: number;
  dedupeKey?: string;
  productIds?: number[];
}

/** 某 category 本周累计多少个新产品才触发横评(默认 3;compare 需要 ≥2 个工具) */
export const ROUNDUP_THRESHOLD = 3;
/** 一篇文章最多带几个产品(prompt 侧 buildArticleSlug 也只取前 3) */
export const MAX_PRODUCTS_PER_ARTICLE = 3;
/** worker / 入队只看这两个状态的产品(草稿不算) */
const COUNTABLE_STATUSES = ['pending', 'published'];

/** Postgres unique 冲突 code —— dedupe_key 撞了说明本周已入队 */
const UNIQUE_VIOLATION = '23505';

/** 一周内有效(产品 created_at >= 周一 00:00 UTC) */
export function startOfISOWeek(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay: 0=周日..6=周六;换算成周一为一周起点(周日记 7)
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() - (day - 1));
  return x;
}

/** ISO 周键,如 2026-W23 —— 用于 dedupe_key,同一周稳定 */
export function isoWeekKey(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day); // 移到本周四,ISO 周年以周四所在年为准
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((x.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${x.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

interface JobRow {
  job_type: ArticleJobType;
  status: 'pending';
  payload: ArticleJobPayload;
  dedupe_key: string;
}

/** 插入一条 job,dedupe_key 撞 unique → 视为本周已入队(非错误) */
async function insertJob(
  sb: SupabaseClient,
  row: JobRow,
): Promise<{ ok: true; id: number } | { ok: false; duplicate: boolean; error?: string }> {
  const { data, error } = await sb
    .from('moxie_article_jobs')
    .insert({ job_type: row.job_type, status: row.status, payload: row.payload, dedupe_key: row.dedupe_key })
    .select('id')
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, duplicate: true };
    return { ok: false, duplicate: false, error: error.message };
  }
  return { ok: true, id: (data as { id: number }).id };
}

export interface CategoryRoundupOptions {
  categoryId: number;
  categorySlug?: string | null;
  threshold?: number;
  template?: ArticleTemplate;
  now?: Date;
}

/**
 * 事件驱动:某 category 本周(ISO 周)新增产品达阈值 → 入队一篇横评。
 * 在 admin promote 成功后调用(best-effort,失败不影响 promote)。
 */
export async function enqueueCategoryRoundup(
  sb: SupabaseClient,
  opts: CategoryRoundupOptions,
): Promise<EnqueueResult> {
  const threshold = opts.threshold ?? ROUNDUP_THRESHOLD;
  const template = opts.template ?? 'compare';
  const now = opts.now ?? new Date();
  const weekStart = startOfISOWeek(now).toISOString();

  // 拉取量取 max(threshold, MAX) —— 计数不被文章产品上限卡住(阈值可调到 > MAX)
  const { data, error } = await sb
    .from('moxie_products')
    .select('id')
    .eq('category_id', opts.categoryId)
    .in('status', COUNTABLE_STATUSES)
    .gte('created_at', weekStart)
    .order('created_at', { ascending: false })
    .limit(Math.max(threshold, MAX_PRODUCTS_PER_ARTICLE));

  if (error) return { enqueued: false, reason: `读取产品失败: ${error.message}` };
  const rows = (data ?? []) as { id: number }[];
  if (rows.length < threshold) {
    return { enqueued: false, reason: `未达阈值(${rows.length}/${threshold})` };
  }

  // 一篇横评最多带 MAX 个(取最近的);buildArticleSlug 也只用前 3 个
  const productIds = rows.slice(0, MAX_PRODUCTS_PER_ARTICLE).map((r) => r.id);
  const dedupeKey = `roundup:${opts.categorySlug ?? opts.categoryId}:${isoWeekKey(now)}`;
  const payload: ArticleJobPayload = {
    template,
    product_ids: productIds,
    category_id: opts.categoryId,
    category_slug: opts.categorySlug ?? null,
    reason: `本周该类目新增 ${rows.length} 个产品达阈值`,
  };

  const res = await insertJob(sb, { job_type: 'category_roundup', status: 'pending', payload, dedupe_key: dedupeKey });
  if (res.ok) return { enqueued: true, reason: '已入队横评', jobId: res.id, dedupeKey, productIds };
  if (res.duplicate) return { enqueued: false, reason: '本周该类目已入队', dedupeKey };
  return { enqueued: false, reason: `入队失败: ${res.error}` };
}

export interface WeeklyTrendOptions {
  limit?: number;
  template?: ArticleTemplate;
  /** 至少几个产品才值得出趋势文 */
  minProducts?: number;
  now?: Date;
}

/**
 * 定时:本周 high-value(featured 或 verified)产品 → 入队一篇选型趋势文。
 * 每周一 cron 调一次(经内部 API)。
 */
export async function enqueueWeeklyTrend(
  sb: SupabaseClient,
  opts: WeeklyTrendOptions = {},
): Promise<EnqueueResult> {
  const limit = opts.limit ?? MAX_PRODUCTS_PER_ARTICLE;
  const template = opts.template ?? 'pick';
  const minProducts = opts.minProducts ?? 1;
  const now = opts.now ?? new Date();
  const weekStart = startOfISOWeek(now).toISOString();

  // high-value:featured(当周精选)或 verified(子墨测过);本周新增;按票数排序取前 N
  const { data, error } = await sb
    .from('moxie_products')
    .select('id')
    .in('status', COUNTABLE_STATUSES)
    .gte('created_at', weekStart)
    .or('featured.eq.true,verified.eq.true')
    .order('vote_count', { ascending: false })
    .limit(limit);

  if (error) return { enqueued: false, reason: `读取产品失败: ${error.message}` };
  const rows = (data ?? []) as { id: number }[];
  if (rows.length < minProducts) {
    return { enqueued: false, reason: `本周 high-value 产品不足(${rows.length}/${minProducts})` };
  }

  const productIds = rows.map((r) => r.id);
  const dedupeKey = `weekly-trend:${isoWeekKey(now)}`;
  const payload: ArticleJobPayload = {
    template,
    product_ids: productIds,
    reason: `本周 ${rows.length} 个 high-value 产品趋势文`,
  };

  const res = await insertJob(sb, { job_type: 'weekly_trend', status: 'pending', payload, dedupe_key: dedupeKey });
  if (res.ok) return { enqueued: true, reason: '已入队周趋势文', jobId: res.id, dedupeKey, productIds };
  if (res.duplicate) return { enqueued: false, reason: '本周趋势文已入队', dedupeKey };
  return { enqueued: false, reason: `入队失败: ${res.error}` };
}
