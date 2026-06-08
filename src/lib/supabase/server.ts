import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server Component / Server Action 用的 Supabase 客户端（cookie session）。
 *
 * 走 anon key，受 RLS 限制。用来：
 *   - auth.getUser() 拿当前登录用户
 *   - 查 moxie_profiles 验 admin 身份
 *   - 读公开数据（受 RLS）
 *
 * 跨 RLS 的写入（promote 时写 moxie_products / 改 candidate status）用
 * src/lib/supabase/admin.ts 的 service_role client。
 */
export async function getSupabaseServerClient() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 未设置',
    );
  }

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component 渲染期不允许写 cookie，吞掉；
          // session 刷新由 auth callback route 处理
        }
      },
    },
  });
}

/**
 * 无 cookie 的 anon 客户端（走 RLS），给**公开只读**内容用（文章详情页、sitemap）。
 *
 * 为什么单独一个:getSupabaseServerClient 依赖 cookies()，会让整页强制动态、
 * 每次访问都打库、无法缓存。公开已发布内容不需要 session，用这个 cookieless
 * client 即可让页面走 ISR 缓存（见 /articles/[slug] 与 sitemap 的 revalidate）。
 */
let cachedAnonClient: SupabaseClient | null = null;
export function getSupabaseAnonClient(): SupabaseClient {
  if (cachedAnonClient) return cachedAnonClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 未设置');
  }
  cachedAnonClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedAnonClient;
}
