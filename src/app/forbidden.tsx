import Link from 'next/link';

/**
 * 自定义 403 页面（forbidden() 触发时渲染）。
 * /admin 非 admin 用户会看到这个。
 */
export default function Forbidden() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center space-y-3">
        <div className="text-5xl font-bold">403</div>
        <p className="text-muted">你已登录，但没有 admin 权限访问此页。</p>
        <p className="text-sm text-muted">
          需要权限请联系管理员把你的 moxie_profiles.role 设为 admin。
        </p>
        <Link href="/" className="inline-block mt-2 text-sm underline hover:text-foreground">
          返回首页
        </Link>
      </div>
    </div>
  );
}
