import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentAdmin } from '@/lib/admin/auth';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Admin Login',
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage() {
  const admin = await getCurrentAdmin();
  if (admin) redirect('/admin/candidates');

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <header className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">MOXIE Admin</h1>
          <p className="text-muted text-sm mt-2">
            内部审核后台，仅 admin 账号可用。输入邮箱收 magic link。
          </p>
        </header>
        <LoginForm />
        <p className="text-xs text-muted text-center">
          非 admin 邮箱会显示"发送失败"——避免邮箱探测，这是设计行为。
        </p>
      </div>
    </div>
  );
}
