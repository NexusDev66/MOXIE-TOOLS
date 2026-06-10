/**
 * latemai 数据管道 · 纯工具函数(无副作用,可被脚本与测试复用)
 * ------------------------------------------------------------------
 * 这里只放确定性、无 I/O、无 process.exit 的纯函数,方便 node:test 单测。
 */

/** 归一域名:去协议 / www / 路径,小写。 @param {string} d @returns {string} */
export function normDomain(d) {
  return String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

/** slug 化:非字母数字→连字符,首尾去连字符,截断 60。 @param {string} s @returns {string} */
export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'tool';
}

/**
 * 生成唯一 slug:撞 knownSlug 就加 domain 词根后缀,再撞加序号。
 * **绝不复用已有 slug**(配合 ignore-duplicates 防覆盖已审产品)。
 * @param {string} name 产品名
 * @param {string} domain 域名(取词根做后缀)
 * @param {Set<string>} knownSlug 已存在的 slug 集
 * @returns {string} 保证不在 knownSlug 中的 slug
 */
export function uniqueSlug(name, domain, knownSlug) {
  let slug = slugify(name);
  if (knownSlug.has(slug)) {
    const base = `${slug}-${String(domain || '').split('.')[0]}`;
    slug = base;
    for (let i = 2; knownSlug.has(slug); i++) slug = `${base}-${i}`;
  }
  return slug;
}
