import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase 客户端。**绕过 RLS**，仅服务端用。
 *
 * 用途:
 *   - /api/internal/* 路由内的写库操作（绕 RLS 直接写 moxie_products / moxie_audit_logs）
 *   - 后续 admin UI 的 server actions 也复用这个
 *
 * 安全约束（必须维持）:
 *   1. 只在 src/app/api/internal/** 或 src/app/admin/**\/actions.ts 里 import
 *   2. 不返回任何 SUPABASE_SERVICE_ROLE_KEY 到前端
 *   3. file 顶层 `import 'server-only'` 强制：任何 client component import 它会 build 时报错
 */

let cached: SupabaseClient | null = null;

export function getSupabaseAdminClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未设置',
    );
  }

  cached = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cached;
}

/** 测试 reset 用 */
export function _resetAdminClient(): void {
  cached = null;
}
