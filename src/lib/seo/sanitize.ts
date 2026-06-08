import 'server-only';
import sanitizeHtml from 'sanitize-html';

/**
 * 文章正文 HTML 消毒（T7）。
 *
 * body_html 来自入库 API（T6），虽是内部 worker 来源,但渲染到公开页前
 * 仍按白名单消毒 —— 去掉 script / on* 事件 / style / iframe / svg 等,
 * 只留排版与媒体标签,外链统一加 rel=nofollow noopener。
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
      // 外链统一加安全 rel + 新标签页打开
      a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer', target: '_blank' }),
      // 图片懒加载
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
    },
  });
}
