/**
 * schema.org JSON-LD 生成 + 安全注入（T12 MOXIE-25）。
 *
 * 纯函数(无 secret / 网络),便于单测:
 *   - 产品详情页 → SoftwareApplication
 *   - 文章详情页 → Article
 *   - jsonLdScript():序列化 + 转义,防 </script> 逃逸 XSS,供 <script type=application/ld+json> 注入
 */

export interface ArticleJsonLdInput {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  publishedAt?: string | null;
  url: string;        // canonical
  brandName: string;  // author / publisher
}

/** Article schema(文章页)。必填:headline / author / publisher / mainEntityOfPage。 */
export function buildArticleJsonLd(a: ArticleJsonLdInput): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    ...(a.description ? { description: a.description } : {}),
    ...(a.imageUrl ? { image: [a.imageUrl] } : {}),
    ...(a.publishedAt ? { datePublished: a.publishedAt, dateModified: a.publishedAt } : {}),
    author: { '@type': 'Organization', name: a.brandName },
    publisher: { '@type': 'Organization', name: a.brandName },
    mainEntityOfPage: { '@type': 'WebPage', '@id': a.url },
  };
}

export interface SoftwareAppJsonLdInput {
  name: string;
  description?: string | null;
  url: string;                                    // canonical
  category?: string | null;                       // applicationCategory
  pricing?: 'free' | 'freemium' | 'paid' | null;  // 有免费档 → 输出 Offer price 0
}

/** SoftwareApplication schema(产品页)。必填:name / applicationCategory / operatingSystem。 */
export function buildSoftwareApplicationJsonLd(t: SoftwareAppJsonLdInput): Record<string, unknown> {
  const hasFreeTier = t.pricing === 'free' || t.pricing === 'freemium';
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    url: t.url,
    applicationCategory: t.category || 'BusinessApplication',
    operatingSystem: 'Web',
    // 仅免费/免费档输出 Offer(price 必须是数值;付费产品无可靠数值价 → 不杜撰,省略 offers)
    ...(hasFreeTier ? { offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } } : {}),
  };
}

/**
 * 序列化成可安全注入 <script type="application/ld+json"> 的字符串。
 * 转义 < > & —— JSON.stringify 不转义,标题/描述含 </script> 可破坏脚本标签注入 XSS。
 */
export function jsonLdScript(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
