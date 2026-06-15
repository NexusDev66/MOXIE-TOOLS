-- 对齐生产库 schema 到内容流水线所需(latemai.com 打通前置)
-- ------------------------------------------------------------------
-- 背景:生产库(latemai.com)是早期静态 UI 的库,缺以下流水线列。
-- detail / traffic_jsonb 当初是直接在 SQL editor 手加到沙盒的,从无迁移文件 → 本迁移补上。
-- weight_score / moxie_news 列在仓库已有迁移,但生产库可能没应用 → 这里 IF NOT EXISTS 兜底。
-- 全部幂等(IF NOT EXISTS / IF EXISTS),可安全重复执行。
--
-- 跑法(对生产库):supabase db push,或在生产库 SQL Editor 直接执行本文件。

-- ── 产品:AI 清洗详情 + 权重 + 第三方流量 ──
alter table moxie_products
  add column if not exists detail jsonb;
comment on column moxie_products.detail is
  'AI 清洗后的结构化详情:{features:[{t,d}], review 短评, review_full[] 完整评测, pricing, tags, test_days, review_date, updated_at}。由 cli/enrich-detail|refresh-review|refresh-fullreview 写,prerender 烤进静态页。';

alter table moxie_products
  add column if not exists weight_score numeric not null default 0;
create index if not exists moxie_products_weight_idx
  on moxie_products (status, weight_score desc);
comment on column moxie_products.weight_score is
  '价值排序权重,由 cli/rank.js 每日重算(人气+verified+featured+完善度+新鲜度+流量)。';

alter table moxie_products
  add column if not exists traffic_jsonb jsonb;
comment on column moxie_products.traffic_jsonb is
  '第三方流量信号(Tranco/SimilarWeb 等),由 cli/fetch-traffic.js 写,作为 rank 的真实信号。';

-- ── 快讯:AI 打分 + 分类 + 中文摘要(cli/score-news.js)──
-- moxie_news 表若不存在则跳过(IF EXISTS);需建表见 20260608130000_moxie_news.sql
alter table if exists moxie_news
  add column if not exists score real;
alter table if exists moxie_news
  add column if not exists category jsonb;
alter table if exists moxie_news
  add column if not exists summary_zh text;

-- 注:moxie_articles.cover_url 生产库已存在,无需新增。
-- 注:若生产库还缺 moxie_news / moxie_voices / moxie_trend_candidates 等表,
--     一并把仓库 supabase/migrations/ 下对应迁移应用到生产库即可(本迁移只补列)。
