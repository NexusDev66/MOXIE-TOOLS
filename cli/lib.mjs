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
 * 决定要清理哪些孤儿 tool 页 —— 带**炸站下限保护**。
 * keep 集为空、或要删超过现有半数 → 判定为"读库异常"(如空读/部分读),返回 null 表示**保守跳过、绝不删**。
 * 正常 reject 只删个位数,触发不了下限;只有读库出错(keep 异常小)才会触发保护。
 * @param {string[]} existingHtml tools/ 下现有 .html 文件名列表
 * @param {Set<string>} keepFiles 应保留的文件名集合(published slug + '.html')
 * @returns {string[]|null} 要删的文件名数组;null = 不安全,应跳过清理
 */
export function orphansToPrune(existingHtml, keepFiles) {
  if (!keepFiles || keepFiles.size === 0) return null;            // 空 published → 疑似空读,绝不删
  const toPrune = existingHtml.filter((f) => !keepFiles.has(f));
  if (toPrune.length > existingHtml.length / 2) return null;       // 要删过半 → 疑似异常,跳过
  return toPrune;
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
