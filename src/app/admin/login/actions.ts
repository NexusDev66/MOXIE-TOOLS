'use server';

import { headers } from 'next/headers';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export interface LoginState {
  ok?: boolean;
  error?: string;
  message?: string;
}

/**
 * 发 magic link。只有 moxie_profiles.role='admin' 的用户登录后才进得了 /admin
 * （守门在 (authed)/layout.tsx）。shouldCreateUser=false 防匿名邮箱探测。
 */
export async function sendMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: '请输入合法邮箱' };
  }

  const supabase = await getSupabaseServerClient();
  const hdrs = await headers();
  const proto = hdrs.get('x-forwarded-proto') ?? 'https';
  const host = hdrs.get('x-forwarded-host') ?? hdrs.get('host') ?? 'www.latemai.com';
  const origin = hdrs.get('origin') ?? `${proto}://${host}`;

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/admin/auth/callback`,
      shouldCreateUser: false,
    },
  });

  if (error) return { error: `发送失败: ${error.message}` };
  return { ok: true, message: '已发送 magic link，去邮箱点链接登录' };
}
