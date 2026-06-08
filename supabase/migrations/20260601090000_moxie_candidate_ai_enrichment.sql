-- ============================================================
-- MOXIE Schema · Migration · moxie_trend_candidates AI 补全字段
-- T5 (MOXIE-17) · AI 自动补全 v0
-- ============================================================
--
-- 用途：
--   admin 在候选审核页点「AI 一键补全」→ 拉官网 HTML + LLM 抽取 5 字段
--   （功能 / 场景 / 定价 / 技术栈 / 创始人）→ 写到 ai_enrichment_jsonb。
--   admin 查看后可「采纳」部分字段填进升级表单，再升级到 moxie_products。
--
-- 设计：
--   - 5 字段 + 元数据全塞一个 jsonb，schema 灵活，v0 不拆列（字段还会调）
--   - ai_enriched_at 单列出来，方便排序 / 过滤「已补全 / 未补全」
--   - 不加新 RLS：moxie_trend_candidates 已是 admin-only（migration_003），
--     新列自动继承表级 policy
-- ============================================================

alter table moxie_trend_candidates
  add column if not exists ai_enrichment_jsonb jsonb,
  add column if not exists ai_enriched_at timestamptz;

comment on column moxie_trend_candidates.ai_enrichment_jsonb is
  'T5 AI 补全结果：{ features, use_cases, pricing, tech_stack, founders, _meta:{provider,model,tokens,cost_usd,source_url,truncated} }。人工审核后采纳到 moxie_products。';
comment on column moxie_trend_candidates.ai_enriched_at is
  'T5 最近一次 AI 补全时间；null = 未补全。';

-- 部分索引：只给「已补全」的行建，列表页按补全时间倒序看最近跑过的
create index if not exists moxie_trend_cand_ai_enriched_idx
  on moxie_trend_candidates (ai_enriched_at desc)
  where ai_enriched_at is not null;
