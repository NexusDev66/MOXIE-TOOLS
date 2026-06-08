-- ============================================================
-- MOXIE Schema · Migration · moxie_audit_logs
-- T2 (MOXIE-14) · 入库 API 审计表
-- ============================================================
--
-- 用途：
--   - 记录每次 /api/internal/* 调用的元数据 + 结果
--   - 不存储完整 payload（防 PII / 节省空间），只存 hash + status + error
--   - admin 排查问题时查"哪个 token 在什么时间 hit 了哪个 endpoint，结果如何"
--
-- 数据保留：建议 90 天后归档（cron job 后续加），本 migration 不强制
-- ============================================================

create table moxie_audit_logs (
  id bigserial primary key,

  -- 来源
  source text not null,                -- 'sync_api' / 'admin_ui' / 'scanner' ...
  endpoint text not null,              -- '/api/internal/products' / ...
  http_method text not null,           -- POST / PATCH / GET
  http_status int not null,            -- 200 / 201 / 401 / 400 / 409 / 500

  -- 目标资源
  target_type text,                    -- 'product' / 'article' / NULL
  target_id bigint,                    -- 写入成功后的资源 id
  target_natural_key text,             -- domain / slug 之类自然键（便于回溯）

  -- token 不存原文，只存 hash 前 12 位
  token_fingerprint text,              -- sha256(token).slice(0,12)

  -- payload 不存原文，只存 hash + 大小
  payload_sha256 text,
  payload_bytes int,

  -- 性能 + 错误
  latency_ms int,
  error_code text,                     -- 'INVALID_PAYLOAD' / 'MISSING_TOKEN' / ...
  error_message text,                  -- 截断到 500 字符

  -- 上下文
  request_id text,                     -- 来自 X-Request-Id header 或自动生成
  user_agent text,

  created_at timestamptz default now()
);

create index moxie_audit_logs_endpoint_idx on moxie_audit_logs (endpoint, created_at desc);
create index moxie_audit_logs_status_idx   on moxie_audit_logs (http_status) where http_status >= 400;
create index moxie_audit_logs_target_idx   on moxie_audit_logs (target_type, target_id);
create index moxie_audit_logs_token_idx    on moxie_audit_logs (token_fingerprint, created_at desc);

-- ============================================================
-- RLS: 仅 admin 可读，所有写入走 service_role 绕 RLS
-- ============================================================
alter table moxie_audit_logs enable row level security;

create policy "moxie_audit_logs_admin_read"
  on moxie_audit_logs for select
  using (moxie_is_admin());

-- 不需要 admin write policy — 写入都来自 server-side service_role
-- 没有 update / delete policy — 审计日志只 append 不改不删


-- ============================================================
-- T2 副带：moxie_products.domain 加 unique 约束
-- ============================================================
--
-- 原因：POST /api/internal/products 用 domain 做幂等键，
-- 需要 DB 层强制 1 domain ≤ 1 product，配合 ON CONFLICT (domain) DO UPDATE
--
-- 已确认: migration_001 的 seed data（12 个产品）domain 各自唯一，加约束不会破
-- 如果以后真有合法的 "1 product 多 domain" 场景（罕见），改用单独的 product_domains 表
-- ============================================================

alter table moxie_products
  add constraint moxie_products_domain_unique unique (domain);

