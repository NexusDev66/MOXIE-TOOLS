import { redirect } from 'next/navigation';

/**
 * /admin 首页：目前 admin 只有候选审核一个页面，直接重定向过去。
 * 守卫在 (authed)/layout.tsx 已经做过（未登录跳 login，非 admin 403）。
 * 以后 admin 多了页面（dashboard 等）再改成真首页。
 */
export default function AdminIndexPage() {
  redirect('/admin/candidates');
}
