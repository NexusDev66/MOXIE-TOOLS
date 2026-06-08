import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSupabaseAnonClient } from '@/lib/supabase/server';
import { sanitizeArticleHtml } from '@/lib/seo/sanitize';
import { absoluteUrl } from '@/lib/seo/config';
import { buildArticleJsonLd, jsonLdScript } from '@/lib/seo/jsonld';
import { ui } from '@/lib/i18n';

// ISR:公开已发布文章用无 cookie 的 anon client 读，整页可缓存,每 5 分钟后台重验
export const revalidate = 300;

/**
 * 文章详情页 /articles/[slug]（T7 MOXIE-19）
 *
 * 数据来自 DB（moxie_articles，T6 写入）。匿名 client 走 RLS：
 * art_read policy = `status='published' or admin`，故公开只看得到已发布文章。
 * body_html 经 sanitize-html 消毒后渲染；带完整 metadata + Article schema.org JSON-LD。
 */

interface ArticleRow {
  slug: string;
  title: string;
  excerpt: string | null;
  cover_url: string | null;
  body_html: string | null;
  category: string | null;
  read_minutes: number | null;
  published_at: string | null;
}

// cache():同一次请求里 generateMetadata 与页面组件共用一次查询,避免查两遍 DB
const getArticle = cache(async (slug: string): Promise<ArticleRow | null> => {
  const sb = getSupabaseAnonClient();
  const { data } = await sb
    .from('moxie_articles')
    .select('slug, title, excerpt, cover_url, body_html, category, read_minutes, published_at')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle<ArticleRow>();
  return data ?? null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const a = await getArticle(slug);
  if (!a) return { title: '文章不存在' };

  const url = absoluteUrl(`/articles/${a.slug}`);
  const description = a.excerpt ?? undefined;
  return {
    title: a.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: a.title,
      description,
      url,
      type: 'article',
      ...(a.published_at ? { publishedTime: a.published_at } : {}),
      ...(a.cover_url ? { images: [{ url: a.cover_url }] } : {}),
    },
    twitter: {
      card: a.cover_url ? 'summary_large_image' : 'summary',
      title: a.title,
      description,
      ...(a.cover_url ? { images: [a.cover_url] } : {}),
    },
  };
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const a = await getArticle(slug);
  if (!a) notFound();

  const safeBody = a.body_html ? sanitizeArticleHtml(a.body_html) : '';
  const url = absoluteUrl(`/articles/${a.slug}`);

  // Article schema.org JSON-LD(T12:抽到 lib/seo/jsonld.ts)
  const jsonLdStr = jsonLdScript(
    buildArticleJsonLd({
      title: a.title,
      description: a.excerpt,
      imageUrl: a.cover_url,
      publishedAt: a.published_at,
      url,
      brandName: ui.brand.name,
    }),
  );

  const dateText = a.published_at
    ? new Date(a.published_at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  return (
    <article className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdStr }} />

      {/* Breadcrumb（暂无文章索引页,不放误导链接;有分类则显示） */}
      <nav className="flex items-center gap-2 text-sm text-muted mb-6">
        <Link href="/" className="hover:text-foreground">首页</Link>
        <span>/</span>
        <span>文章</span>
        {a.category && (
          <>
            <span>/</span>
            <span>{a.category}</span>
          </>
        )}
      </nav>

      <header className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight mb-3">{a.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {a.category && <span>{a.category}</span>}
          {dateText && <span>· {dateText}</span>}
          {a.read_minutes ? <span>· 约 {a.read_minutes} 分钟</span> : null}
        </div>
        {a.excerpt && <p className="text-lg text-foreground/80 mt-4 leading-relaxed">{a.excerpt}</p>}
      </header>

      {a.cover_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={a.cover_url} alt={a.title} className="w-full rounded-xl border border-border mb-8" />
      )}

      {safeBody ? (
        <div
          className="prose prose-zinc max-w-none prose-img:rounded-lg prose-a:text-emerald-700"
          dangerouslySetInnerHTML={{ __html: safeBody }}
        />
      ) : (
        <p className="text-muted">（正文为空）</p>
      )}
    </article>
  );
}
