import 'server-only';
import sanitizeHtml from 'sanitize-html';

/**
 * 生成文章正文 HTML 落库前消毒（T8 复审修正）。
 *
 * LLM 返回的 body_html 落 moxie_articles 前按白名单消毒 —— 去掉 script / on* 事件 /
 * style / iframe / svg 等,只留排版与媒体标签,外链统一加 rel=nofollow noopener。
 * 防"产品资料提示注入 → LLM 产出恶意标签 → admin 预览/渲染入口存储型 XSS"。
 *
 * 注:allowlist 与 T7 的 src/lib/seo/sanitize.ts 一致;两分支合并后应统一到一处。
 */
export function sanitizeArticleHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li',
      'strong', 'em', 'b', 'i', 'a', 'img', 'figure', 'figcaption',
      'code', 'pre', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['http', 'https'], a: ['http', 'https', 'mailto'] },
    disallowedTagsMode: 'discard',
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer', target: '_blank' }),
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
    },
  });
}
