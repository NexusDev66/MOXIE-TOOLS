-- ============================================================
-- MOXIE Schema · Migration · 自动配图字段
-- T9 (MOXIE-22) · Playwright 截官网首屏 → moxie-covers
-- ============================================================
--
-- moxie_products 加 cover_url:产品封面(截图/OG/favicon),存 moxie-covers。
-- moxie_trend_candidates 加 screenshot_url:候选官网截图;admin 升级候选时
-- 带入 product.cover_url(截图存候选上,升级时迁移)。
--
-- 不加新 RLS:两列继承所在表的 policy
--   - moxie_products 公开可读
--   - moxie_trend_candidates admin-only(migration_003)
-- ============================================================

alter table moxie_products
  add column if not exists cover_url text;
comment on column moxie_products.cover_url is
  'T9 产品封面图(Playwright 截官网首屏 / 兜底 OG image / favicon),存 moxie-covers/products/<slug>/';

alter table moxie_trend_candidates
  add column if not exists screenshot_url text;
comment on column moxie_trend_candidates.screenshot_url is
  'T9 候选官网截图 URL(存 moxie-covers);admin 升级候选时带入 product.cover_url。';
