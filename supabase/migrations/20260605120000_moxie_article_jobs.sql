-- ============================================================
-- MOXIE Schema · Migration · 文章生成任务队列
-- T10 (MOXIE-23) · 文章生成触发器:候选阈值 + cron 周生成
-- ============================================================
--
-- 触发器两路往本表 enqueue,cron worker 消费后调 T8 generateArticleDraft 出草稿:
--   (1) 事件驱动:某 category 本周新增 promoted 产品 >= N → enqueue 横评(compare)
--       —— 口径用 moxie_products.category_id(candidates 表无类目列,见 docs/article-triggers.md)
--   (2) 定时:每周一 cron 拉本周 high-value(featured/verified)产品 → enqueue 选型(pick)趋势文
--
-- 幂等:dedupe_key unique,同类目同 ISO 周 / 同周趋势文只入队一次。
-- ============================================================

create table if not exists moxie_article_jobs (
  id          bigserial primary key,
  job_type    text not null,                       -- 'category_roundup' | 'weekly_trend'
  status      text not null default 'pending',     -- pending | processing | done | failed | skipped
  payload     jsonb not null default '{}'::jsonb,  -- { template, product_ids, category_id, category_slug, reason }
  dedupe_key  text unique,                         -- 幂等键;null 不参与去重
  result      jsonb,                               -- { article_id, slug, skipped, ... }
  attempts    int  not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists moxie_article_jobs_status_idx
  on moxie_article_jobs (status, created_at);

comment on table moxie_article_jobs is
  'T10 文章生成任务队列。事件驱动(promote 同类目本周积累>=N)/周 cron 入队,worker 消费调 T8 生成草稿。';
comment on column moxie_article_jobs.dedupe_key is
  '幂等键:category_roundup=roundup:<cat_slug>:<isoWeek>;weekly_trend=weekly-trend:<isoWeek>。unique 防重复入队。';
comment on column moxie_article_jobs.status is
  'pending=待处理 / processing=worker 已认领 / done=已出草稿 / skipped=同 slug 已发布跳过 / failed=生成失败。';

-- RLS:admin-only(对齐 moxie_trend_candidates,migration_003)。
-- service_role 绕 RLS —— worker 与触发器都用 service key 写。
alter table moxie_article_jobs enable row level security;
create policy "moxie_article_jobs_admin" on moxie_article_jobs
  for all using (moxie_is_admin()) with check (moxie_is_admin());

-- updated_at 自动维护(任何 update 自动刷新)
create or replace function moxie_article_jobs_touch() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger moxie_article_jobs_touch_trg
  before update on moxie_article_jobs
  for each row execute function moxie_article_jobs_touch();
