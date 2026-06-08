#!/usr/bin/env node
/**
 * Phase 1.1 · 产品页预渲染(SEO)
 *
 * 读 published 产品 → 以 moxie-product.html 为模板 → 为每个产品生成静态副本
 * tools/<slug>.html,把内容烤进 HTML + 注入 <title>/<meta>/canonical/OG/JSON-LD,
 * 让爬虫直接看到内容(纯客户端渲染对 SEO 无效)。源模板不改。
 *
 * 跑法:node --env-file=.env.local cli/prerender.js
 * 读数据用 anon key(只读 published),不需要 service key。
 * 部署/canonical 域名:env SITE_BASE_URL(默认 https://www.latemai.com)。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SITE_BASE = (process.env.SITE_BASE_URL || 'https://www.latemai.com').replace(/\/+$/, '');
if (!SUPABASE_URL || !ANON) {
  console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY(.env.local)');
  process.exit(1);
}

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const OUT_DIR = join(ROOT, 'tools');

/** HTML 转义(文本 + 属性通用) */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** JSON-LD 注入转义,防 </script> 逃逸 */
function jsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

async function fetchPublishedProducts() {
  const url = `${SUPABASE_URL}/rest/v1/moxie_products?status=eq.published&select=slug,name,domain,tagline,tags,price_label,vote_count,moxie_categories(name,slug)&order=vote_count.desc&limit=1000`;
  const res = await fetch(url, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  if (!res.ok) throw new Error(`读取产品失败 ${res.status}: ${await res.text()}`);
  return res.json();
}

function buildSeoHead(p, canonical) {
  const catName = p.moxie_categories?.name || 'AI 工具';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: p.name,
    description: p.tagline,
    url: canonical,
    applicationCategory: catName,
    operatingSystem: 'Web',
    ...(/免费/.test(p.price_label || '') ? { offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } } : {}),
  };
  return [
    `<meta name="description" content="${esc(p.tagline)}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(p.name)} · MOXIE">`,
    `<meta property="og:description" content="${esc(p.tagline)}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<script type="application/ld+json">${jsonLd(ld)}</script>`,
  ].join('\n');
}

/** 把模板渲染成某个产品的 SEO 静态页 */
function renderProduct(tpl, p) {
  const canonical = `${SITE_BASE}/tools/${p.slug}`;
  let html = tpl;
  const checks = [];
  const rep = (from, to, label) => {
    if (!html.includes(from)) { checks.push(`⚠ 未找到[${label}]`); return; }
    html = html.replace(from, to);
  };

  // 1. 资源相对路径 → 根绝对(输出在 /tools/ 子目录,相对路径会错)
  html = html
    .replace(/(href|src)="(moxie-[^"]*)"/g, '$1="/$2"')
    .replace(/(href|src)="(public\/[^"]*)"/g, '$1="/$2"');

  // 2. <title>
  rep('<title>DeepSeek V3 · MOXIE</title>', `<title>${esc(p.name)} · MOXIE</title>`, 'title');

  // 3. <head> 注入 SEO(meta/canonical/og/JSON-LD)
  rep('</head>', `${buildSeoHead(p, canonical)}\n</head>`, 'head');

  // 4. 正文烤入(爬虫可见)
  rep('<h1 id="phName">加载中…</h1>', `<h1 id="phName">${esc(p.name)}</h1>`, 'phName');
  rep('<span class="prod-hero-url" id="phUrl"></span>', `<span class="prod-hero-url" id="phUrl">${esc(p.domain)}</span>`, 'phUrl');
  rep('<p class="prod-hero-desc" id="phDesc"></p>', `<p class="prod-hero-desc" id="phDesc">${esc(p.tagline)}</p>`, 'phDesc');
  rep('domain=deepseek.com&sz=128', `domain=${esc(p.domain)}&sz=128`, 'favicon');

  // 5. 让客户端 JS hydrate 本产品(原本从 ?slug= 读)
  rep(
    "const slug = new URLSearchParams(location.search).get('slug') || 'deepseek-v3';",
    `const slug = ${JSON.stringify(p.slug)};`,
    'slug',
  );

  return { html, checks };
}

async function main() {
  console.log(`\n🖨  Phase 1.1 产品页预渲染 · base=${SITE_BASE}\n`);
  const tpl = readFileSync(join(ROOT, 'moxie-product.html'), 'utf8');
  const products = await fetchPublishedProducts();
  console.log(`   读到 published 产品:${products.length}`);

  mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;
  const warned = new Set();
  for (const p of products) {
    const { html, checks } = renderProduct(tpl, p);
    if (checks.length) checks.forEach((c) => warned.add(c));
    writeFileSync(join(OUT_DIR, `${p.slug}.html`), html, 'utf8');
    ok++;
  }
  console.log(`✓ 生成 ${ok} 个静态产品页 → tools/<slug>.html`);
  if (warned.size) console.log('   模板替换告警(可能模板结构变了):', [...warned].join(' '));
  console.log(`\n抽查:tools/${products[0]?.slug}.html\n`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
