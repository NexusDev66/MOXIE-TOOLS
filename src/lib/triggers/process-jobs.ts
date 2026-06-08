import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { generateArticleDraft, type GenerateResult } from '@/lib/article-gen/generate';
import type { ArticleJobPayload } from './article-enqueue';
import type { ArticleTemplate } from '@/lib/article-gen/templates';

/**
 * 文章任务 worker（T10 MOXIE-23 / AC-3）
 *
 * 消费 moxie_article_jobs 里 status=pending 的任务,逐条调 T8 generateArticleDraft 出草稿。
 * 由 cron(经内部 API /api/internal/article-jobs/process)触发。
 *
 * 认领模型:update pending→processing 带条件,认领成功(返回行)才处理 —— 防并发重复消费。
 * generate 可注入(测试传 mock),不传用 T8 真实实现。
 */

export type GenerateFn = (
  productIds: number[],
  template: ArticleTemplate,
) => Promise<GenerateResult>;

export interface ProcessDeps {
  sb?: SupabaseClient;
  generate?: GenerateFn;
  /** 注入时钟(测试用),默认 new Date() */
  now?: () => Date;
}

export interface JobOutcome {
  jobId: number;
  status: 'done' | 'failed' | 'skipped' | 'retry';
  articleId?: number;
  slug?: string;
  error?: string;
}

export interface ProcessSummary {
  picked: number;
  done: number;
  failed: number;
  skipped: number;
  /** 生成出错但未达重试上限,已回 pending 等下次 */
  retried: number;
  outcomes: JobOutcome[];
}

interface PendingJob {
  id: number;
  payload: ArticleJobPayload;
  attempts: number;
}

const DEFAULT_LIMIT = 3;   // 单次小批,配合路由 maxDuration=60 不超时
/** processing 超过这么久 = 上次 worker 超时/崩溃没 finish,回收重处理 */
const STALE_MINUTES = 15;
/** 回收重试上限;超了判 failed,避免毒任务(每次都超时)无限空烧 LLM */
const MAX_ATTEMPTS = 3;

export async function processArticleJobs(
  opts: { limit?: number } = {},
  deps: ProcessDeps = {},
): Promise<ProcessSummary> {
  const sb = deps.sb ?? getSupabaseAdminClient();
  const generate = deps.generate ?? ((ids, tpl) => generateArticleDraft(ids, tpl));
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const now = deps.now ?? (() => new Date());

  // 回收卡死的 processing(上次超时/崩溃)。单 cron worker,无并发争用。
  // 先把超时且已达重试上限的判 failed,其余回 pending 重试。
  const staleCutoff = new Date(now().getTime() - STALE_MINUTES * 60_000).toISOString();
  await sb
    .from('moxie_article_jobs')
    .update({ status: 'failed', last_error: `worker 超时/崩溃,超过最大重试次数(${MAX_ATTEMPTS})` })
    .eq('status', 'processing')
    .lt('updated_at', staleCutoff)
    .gte('attempts', MAX_ATTEMPTS);
  await sb
    .from('moxie_article_jobs')
    .update({ status: 'pending' })
    .eq('status', 'processing')
    .lt('updated_at', staleCutoff)
    .lt('attempts', MAX_ATTEMPTS);

  const { data, error } = await sb
    .from('moxie_article_jobs')
    .select('id, payload, attempts')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`读取任务队列失败: ${error.message}`);
  const jobs = (data ?? []) as PendingJob[];

  const summary: ProcessSummary = { picked: 0, done: 0, failed: 0, skipped: 0, retried: 0, outcomes: [] };

  for (const job of jobs) {
    const attemptsNow = (job.attempts ?? 0) + 1;
    // 认领:pending → processing,带 status 条件防并发重复消费
    const { data: claimed } = await sb
      .from('moxie_article_jobs')
      .update({ status: 'processing', attempts: attemptsNow })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('id');
    if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) {
      // 已被别的 worker 认领,跳过
      continue;
    }
    summary.picked++;

    const { template, product_ids } = job.payload ?? ({} as ArticleJobPayload);
    if (!Array.isArray(product_ids) || product_ids.length === 0 || !template) {
      // 数据错误(非瞬时),不重试,直接 failed
      await finish(sb, job.id, 'failed', { last_error: 'payload 缺 template / product_ids' });
      summary.failed++;
      summary.outcomes.push({ jobId: job.id, status: 'failed', error: 'payload 缺 template / product_ids' });
      continue;
    }

    let result: GenerateResult;
    try {
      result = await generate(product_ids, template);
    } catch (e) {
      await concludeFailure(sb, job.id, attemptsNow, e instanceof Error ? e.message : String(e), summary);
      continue;
    }

    if (result.ok && result.article) {
      await finish(sb, job.id, 'done', {
        result: { article_id: result.article.id, slug: result.article.slug, meta: result.meta ?? null },
      });
      summary.done++;
      summary.outcomes.push({ jobId: job.id, status: 'done', articleId: result.article.id, slug: result.article.slug });
    } else if (result.skipped) {
      await finish(sb, job.id, 'skipped', { result: { skipped: true, error: result.error ?? null } });
      summary.skipped++;
      summary.outcomes.push({ jobId: job.id, status: 'skipped', error: result.error });
    } else {
      await concludeFailure(sb, job.id, attemptsNow, result.error ?? '生成失败', summary);
    }
  }

  return summary;
}

/**
 * 生成失败(抛错 / result 非 ok)的收尾:未达重试上限 → 回 pending 下次重试;
 * 到上限 → 判 failed。瞬时错误(LLM 5xx/网络)靠这个自动恢复,毒任务被 MAX_ATTEMPTS 兜住。
 */
async function concludeFailure(
  sb: SupabaseClient,
  jobId: number,
  attemptsNow: number,
  msg: string,
  summary: ProcessSummary,
): Promise<void> {
  if (attemptsNow < MAX_ATTEMPTS) {
    await sb
      .from('moxie_article_jobs')
      .update({ status: 'pending', last_error: `第 ${attemptsNow} 次失败,待重试: ${msg}`.slice(0, 500) })
      .eq('id', jobId);
    summary.retried++;
    summary.outcomes.push({ jobId, status: 'retry', error: msg });
  } else {
    await finish(sb, jobId, 'failed', { last_error: `超 ${MAX_ATTEMPTS} 次仍失败: ${msg}` });
    summary.failed++;
    summary.outcomes.push({ jobId, status: 'failed', error: msg });
  }
}

async function finish(
  sb: SupabaseClient,
  jobId: number,
  status: 'done' | 'failed' | 'skipped',
  fields: { result?: unknown; last_error?: string },
): Promise<void> {
  await sb
    .from('moxie_article_jobs')
    .update({ status, result: fields.result ?? null, last_error: fields.last_error ?? null })
    .eq('id', jobId);
}
