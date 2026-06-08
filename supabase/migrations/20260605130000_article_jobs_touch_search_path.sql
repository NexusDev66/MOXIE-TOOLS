-- ============================================================
-- MOXIE Schema · Migration · 修 moxie_article_jobs_touch 固定 search_path
-- T11 (MOXIE-24) 顺带修 T10 复审 P2
-- ============================================================
--
-- T10 的触发函数没固定 search_path,Supabase linter 标 function_search_path_mutable。
-- 原迁移(20260605120000)已合并、不能回改(对已建表的库不重跑),故用新迁移
-- create or replace 重建函数,加 set search_path,封 search_path 注入面。函数体不变。
-- ============================================================

create or replace function moxie_article_jobs_touch() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
