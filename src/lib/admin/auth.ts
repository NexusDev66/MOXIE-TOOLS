import 'server-only';
import { cache } from 'react';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Admin 身份判断 DAL。
 *   - React cache() 做请求级 memoization：layout + page 各调一次只查一次 DB
 *   - 返回最小 DTO，不暴露内部字段
 */

export interface AdminUser {
  userId: string;
  email: string | null;
  displayName: string | null;
}

export const getCurrentAdmin = cache(async (): Promise<AdminUser | null> => {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('moxie_profiles')
    .select('user_id, display_name, role')
    .eq('user_id', user.id)
    .maybeSingle<{ user_id: string; display_name: string | null; role: string }>();

  if (!profile || profile.role !== 'admin') return null;

  return {
    userId: profile.user_id,
    email: user.email ?? null,
    displayName: profile.display_name,
  };
});
