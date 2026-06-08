-- ============================================================
-- Phase 2 · 产品综合权重分(latemai 数据闭环)
-- ============================================================
-- weight_score:供首页/列表按"价值"排序,由 cli/rank.js 每日重算。
-- 综合:票数(log) + 子墨测过 + 当周精选 + 完善度 + 时效[ + SimilarWeb 流量,待配 key]。
-- ============================================================

alter table moxie_products
  add column if not exists weight_score numeric not null default 0;

create index if not exists moxie_products_weight_idx
  on moxie_products (status, weight_score desc);

comment on column moxie_products.weight_score is
  'Phase2 综合权重(vote/verified/featured/完善度/时效[/流量]);cli/rank.js 每日重算,UI 按它降序。';
