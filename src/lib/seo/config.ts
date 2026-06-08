/**
 * 站点级 SEO 配置（T7 MOXIE-19）。
 *
 * SITE_URL 用于 canonical / OG / sitemap 的绝对 URL。
 * 生产可用 env NEXT_PUBLIC_SITE_URL 覆盖（不配则用默认域名）。
 */

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://latemai.com').replace(/\/$/, '');

/** 拼绝对 URL（path 以 / 开头） */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
