import type { MetadataRoute } from 'next';
import { tools } from '@/lib/data';
import { getSupabaseAnonClient } from '@/lib/supabase/server';
import { absoluteUrl } from '@/lib/seo/config';

// 无 cookie anon client + ISR:sitemap 可缓存，每小时后台重验（不必每次请求打库）
export const revalidate = 3600;

/**
 * 动态 sitemap（T7 AC-2）。Next 16 原生约定:导出 default 返回 MetadataRoute.Sitemap。
 *
 *   - 静态主路由 + products(静态 @/lib/data) + articles(DB moxie_articles，已发布，带 lastmod)
 *   - DB 不可用时降级:仍返回静态 + products 部分，不让整个 sitemap 挂掉
 */

const STATIC_ROUTES: Array<{ path: string; priority: number }> = [
  { path: '/', priority: 1 },
  { path: '/tools', priority: 0.8 },
  { path: '/learn', priority: 0.7 },
  { path: '/marketplace', priority: 0.6 },
  { path: '/services', priority: 0.6 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => ({
    url: absoluteUrl(r.path),
    changeFrequency: 'weekly',
    priority: r.priority,
  }));

  // products：当前公开站由静态 @/lib/data 驱动
  const toolRoutes: MetadataRoute.Sitemap = tools.map((t) => ({
    url: absoluteUrl(`/tools/${t.slug}`),
    changeFrequency: 'weekly',
    priority: 0.6,
  }));

  // articles：从 DB 拉已发布文章（匿名 client 走 RLS，只返回 published）
  let articleRoutes: MetadataRoute.Sitemap = [];
  try {
    const sb = getSupabaseAnonClient();
    const { data } = await sb
      .from('moxie_articles')
      .select('slug, published_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(5000);
    const rows = (data ?? []) as Array<{ slug: string; published_at: string | null }>;
    articleRoutes = rows.map((a) => ({
      url: absoluteUrl(`/articles/${a.slug}`),
      ...(a.published_at ? { lastModified: new Date(a.published_at) } : {}),
      changeFrequency: 'monthly',
      priority: 0.5,
    }));
  } catch {
    // DB 拉取失败 → sitemap 仍返回静态 + products，不整体失败
    articleRoutes = [];
  }

  return [...staticRoutes, ...toolRoutes, ...articleRoutes];
}
