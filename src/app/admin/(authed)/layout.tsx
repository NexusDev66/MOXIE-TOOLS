import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect, forbidden } from 'next/navigation';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getCurrentAdmin } from '@/lib/admin/auth';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · MOXIE Admin' },
  robots: { index: false, follow: false },
};

/**
 * 路由组 (authed) 守卫（AC-3）：
 *   - 未登录            → redirect /admin/login
 *   - 登录但非 admin     → forbidden()（真 HTTP 403，需 next.config authInterrupts）
 *   - admin             → 渲染 chrome + children
 *
 * /admin/login 和 /admin/auth/callback 不在 (authed) 组内，绕开本守卫。
 */
export default async function AdminAuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 先判断"有没有登录"，区分 401(未登录→去登录) 和 403(登录了但不是 admin)
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/admin/login');

  const admin = await getCurrentAdmin();
  if (!admin) forbidden();   // 登录了但 role != admin → 403

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/admin/candidates" className="font-semibold tracking-tight">
              MOXIE Admin
            </Link>
            <nav className="flex items-center gap-4 text-sm text-muted">
              <Link href="/admin/candidates" className="hover:text-foreground">候选审核</Link>
              <Link href="/admin/article-jobs" className="hover:text-foreground">文章队列</Link>
            </nav>
          </div>
          <span className="text-sm text-muted">{admin.email}</span>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
