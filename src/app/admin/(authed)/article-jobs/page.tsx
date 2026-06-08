import type { Metadata } from 'next';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: '文章任务队列',
};

const PAGE_SIZE = 80;

interface JobRow {
  id: number;
  job_type: string;
  status: string;
  payload: {
    template?: string;
    product_ids?: number[];
    category_slug?: string | null;
    reason?: string;
  } | null;
  result: { article_id?: number; slug?: string; skipped?: boolean } | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  processing: 'bg-sky-50 text-sky-700 border-sky-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  skipped: 'bg-zinc-100 text-zinc-500 border-zinc-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
};

const TYPE_LABEL: Record<string, string> = {
  category_roundup: '类目横评',
  weekly_trend: '周趋势',
};

const TEMPLATE_LABEL: Record<string, string> = {
  compare: '横评',
  pick: '选型',
  guide: '手册',
};

export default async function ArticleJobsPage() {
  // RLS: moxie_article_jobs 仅 admin 可读(migration)。admin 已登录 → 读得到
  const sb = await getSupabaseServerClient();

  const { data: jobs, error } = await sb
    .from('moxie_article_jobs')
    .select('id, job_type, status, payload, result, attempts, last_error, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE)
    .returns<JobRow[]>();

  const counts = (jobs ?? []).reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">文章任务队列</h1>
        <p className="text-muted text-sm mt-1">
          触发器(promote 类目积累 / 每日 cron)入队,worker 消费后调 AI 生成草稿(status=draft 待审)。
        </p>
        {jobs && jobs.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3 text-xs">
            {['pending', 'processing', 'done', 'skipped', 'failed'].map(
              (s) =>
                counts[s] ? (
                  <span key={s} className={`px-2 py-0.5 rounded-md border ${STATUS_BADGE[s]}`}>
                    {s} {counts[s]}
                  </span>
                ) : null,
            )}
          </div>
        )}
      </header>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50/30 p-4 text-rose-600 text-sm">
          加载失败: {error.message}
        </div>
      ) : !jobs || jobs.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted">
          队列为空。等触发器入队(类目本周积累达阈值,或每日 cron 生成周趋势文)。
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
          {jobs.map((j) => (
            <div key={j.id} className="p-4 flex items-start gap-4">
              <div className="shrink-0 w-10 text-xs text-muted pt-0.5">#{j.id}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-md border ${STATUS_BADGE[j.status] ?? 'border-border'}`}>
                    {j.status}
                  </span>
                  <span className="text-sm font-medium">{TYPE_LABEL[j.job_type] ?? j.job_type}</span>
                  {j.payload?.template && (
                    <span className="text-xs text-muted">
                      模板 {TEMPLATE_LABEL[j.payload.template] ?? j.payload.template}
                    </span>
                  )}
                  {j.payload?.category_slug && (
                    <span className="text-xs text-muted">类目 {j.payload.category_slug}</span>
                  )}
                  {j.attempts > 1 && <span className="text-xs text-muted">重试 {j.attempts}</span>}
                </div>
                <div className="text-xs text-muted">
                  产品 {j.payload?.product_ids?.length ?? 0} 个
                  {j.payload?.reason ? ` · ${j.payload.reason}` : ''}
                </div>
                {j.status === 'done' && j.result?.slug && (
                  <div className="text-xs text-emerald-600 mt-1">
                    → 草稿 {j.result.slug}（文章 #{j.result.article_id}）
                  </div>
                )}
                {j.status === 'failed' && j.last_error && (
                  <div className="text-xs text-rose-600 mt-1 break-all">✗ {j.last_error}</div>
                )}
              </div>
              <time className="shrink-0 text-xs text-muted pt-0.5" dateTime={j.created_at}>
                {new Date(j.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </time>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted mt-4">
        显示最近 {PAGE_SIZE} 条。done 的任务生成的是 status=draft 草稿,去文章审核页发布。
      </p>
    </div>
  );
}
