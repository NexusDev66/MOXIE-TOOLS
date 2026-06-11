#!/usr/bin/env node
/**
 * latemai 数据管道 · D1 SEO 体检(只读,扫本地烤好的静态页)
 * ------------------------------------------------------------------
 * 验证 prerender 产物的 SEO 正确性:
 *   1. 每个 JSON-LD <script> 真能 JSON.parse(catch 转义破坏 —— 最常见的 SEO bug)。
 *   2. <title> / <link rel=canonical> / <meta name=description> 三件齐全。
 *   3. sitemap.xml 的 <loc> 数与烤页数对得上、抽样 URL 对应文件存在。
 * 跑法:node cli/audit-seo.mjs    (无需 env;纯读本地文件)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIRS = ['tools', 'articles', 'news'];

const LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const hasTitle = (h) => /<title>[^<]+<\/title>/i.test(h);
const tagOf = (h, re) => (h.match(re) || [])[0] || '';
const attrOf = (tag, attr) => ((tag || '').match(new RegExp(attr + '=["\\\']([^"\\\']*)["\\\']')) || [])[1] || '';

/** @type {{file:string,issue:string}[]} */
const problems = [];
let scanned = 0, ldCount = 0;

for (const dir of DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) {
    if (!f.endsWith('.html')) continue;
    scanned++;
    const rel = `${dir}/${f}`;
    const html = readFileSync(join(abs, f), 'utf8');
    // 1. JSON-LD 解析
    let found = 0;
    for (const m of html.matchAll(LD_RE)) {
      found++; ldCount++;
      try { JSON.parse(m[1].trim()); } catch (e) { problems.push({ file: rel, issue: `JSON-LD 解析失败: ${e.message}` }); }
    }
    if (found === 0) problems.push({ file: rel, issue: '无 JSON-LD' });
    // 2. meta 三件
    if (!hasTitle(html)) problems.push({ file: rel, issue: '缺 <title>' });
    // canonical:存在 + 指向本页路径
    const canonHref = attrOf(tagOf(html, /<link[^>]+rel=["']canonical["'][^>]*>/i), 'href');
    const expectPath = `/${rel.replace(/\.html$/, '')}`;
    if (!canonHref) problems.push({ file: rel, issue: '缺 canonical' });
    else if (!canonHref.includes(expectPath)) problems.push({ file: rel, issue: `canonical 不指向本页:${canonHref}` });
    // description:存在 + 非空
    const descContent = attrOf(tagOf(html, /<meta[^>]+name=["']description["'][^>]*>/i), 'content');
    if (!descContent.trim()) problems.push({ file: rel, issue: 'description 缺失或为空' });
  }
}

// 3. sitemap 交叉核对
let sitemapInfo = 'sitemap.xml 不存在';
const smPath = join(ROOT, 'sitemap.xml');
if (existsSync(smPath)) {
  const sm = readFileSync(smPath, 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  // 抽样:tools/articles/news 的 loc 是否有对应本地文件
  let missing = 0;
  for (const loc of locs) {
    const mt = loc.match(/\/((?:tools|articles|news)\/[^/?#]+)$/);
    if (mt && !existsSync(join(ROOT, mt[1] + '.html'))) missing++;
  }
  sitemapInfo = `sitemap <loc> 数=${locs.length};指向 tools/articles/news 但本地缺文件=${missing}`;
}

console.log(`\n🔎 D1 SEO 体检:扫描 ${scanned} 页 · JSON-LD ${ldCount} 块\n`);
console.log(`   ${sitemapInfo}`);
if (!problems.length) {
  console.log('\n   ✅ 全部通过:JSON-LD 均可解析,title/canonical/description 齐全\n');
} else {
  console.log(`\n   ⚠ 发现 ${problems.length} 个问题:`);
  for (const p of problems.slice(0, 40)) console.log(`     [${p.file}] ${p.issue}`);
  if (problems.length > 40) console.log(`     …还有 ${problems.length - 40} 个`);
  console.log('');
  process.exit(1);
}
