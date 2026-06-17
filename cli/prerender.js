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

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { orphansToPrune } from './lib.mjs';
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
const OUT_ARTICLES = join(ROOT, 'articles');
const OUT_NEWS = join(ROOT, 'news');

/** HTML 转义(文本 + 属性通用) */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** JSON-LD 注入转义,防 </script> 逃逸 */
function jsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

async function fetchPublishedProducts() {
  const url = `${SUPABASE_URL}/rest/v1/moxie_products?status=eq.published&select=id,slug,name,domain,tagline,tags,price_label,vote_count,domestic_available,verified,created_at,detail,category_id,moxie_categories(name,slug)&order=vote_count.desc&limit=1000`;
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
function renderProduct(tpl, p, ctx = {}) {
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
  rep('/public/logos/deepseek.com.png', `/public/logos/${esc(p.domain)}.png`, 'phLogo'); // 本地 logo(大陆不碰 Google)
  rep('<a id="phVisit" href="#"', `<a id="phVisit" href="https://${esc(p.domain)}?ref=moxie"`, 'visit');
  // 侧栏「访问产品官网」按钮:模板写死 deepseek.com,必须替成本产品域名(否则全站都跳 deepseek)
  rep('<a href="https://deepseek.com?ref=moxie" target="_blank" rel="noopener noreferrer" class="btn-block primary">',
    `<a href="https://${esc(p.domain)}?ref=moxie" target="_blank" rel="noopener noreferrer" class="btn-block primary">`, 'visit-official');
  // 面包屑当前产品名(模板写死 DeepSeek V3)
  rep('<span>DeepSeek V3</span>', `<span>${esc(p.name)}</span>`, 'breadcrumb');

  // 5. 让客户端 JS hydrate 本产品(原本从 ?slug= 读)
  rep(
    "const slug = new URLSearchParams(location.search).get('slug') || 'deepseek-v3';",
    `const slug = ${JSON.stringify(p.slug)};`,
    'slug',
  );

  // 6. 产品信息侧栏:模板是写死 demo(分类/价格/国内可用全固定)→ 用真数据重建
  const infoRe = /<div class="info-list">[\s\S]*?\n\s*<\/div>/;
  if (infoRe.test(html)) html = html.replace(infoRe, buildInfoList(p));
  else checks.push('⚠ 未找到[info-list]');

  // 7. 详情页正文板块(子墨评测/核心特点/价格/同类替代):模板写死 demo → 用 detail + 同类产品重建
  html = bakeDetailSections(html, p, ctx, checks);

  return { html, checks };
}

/** 详情页正文 4 板块按 HTML 注释边界整段替换为真数据 */
function bakeDetailSections(html, p, ctx, checks) {
  const d = p.detail || {};
  const ind = '        ';
  function sec(comment, next, inner) {
    const re = new RegExp(`<!-- ${comment} -->[\\s\\S]*?(?=<!-- ${next} -->)`);
    const block = `<!-- ${comment} -->\n${ind}<div class="prod-section">\n${inner}\n${ind}</div>\n\n${ind}`;
    if (re.test(html)) html = html.replace(re, block);
    else if (checks) checks.push(`⚠ 未找到[${comment}]`);
  }
  // 点评(原"子墨评测"):头部 = 测试天数(仅 verified 显示),底部 = 发布日期 + 署名
  const review = (d.review || p.tagline || '').trim();
  const days = Number(d.test_days) || 0;
  const rdate = String(d.review_date || d.updated_at || '').slice(0, 10).replace(/-/g, '.');
  const noteHead = `<div class="editor-note-head">EDITOR'S NOTE${days ? ` · 测试 ${days} 天` : ''}</div>`;
  const metaBits = [];
  if (rdate) metaBits.push(`${esc(rdate)} 发布`);
  metaBits.push(days ? '子墨 亲测' : '子墨 整理');
  const noteMeta = `<div class="editor-note-meta">${metaBits.join(' · ')}</div>`;
  // 完整评测(仅 verified 有 review_full):可展开长文
  const full = Array.isArray(d.review_full) ? d.review_full.filter(Boolean) : [];
  const fullBlock = full.length
    ? `<details class="full-review" id="full-review"><summary>阅读完整评测</summary><div class="full-review-body">${full.map((t) => `<p>${esc(t)}</p>`).join('')}</div></details>`
    : '';
  sec('子墨评测', '核心特点', `          <h2>子墨测评</h2>\n          <div class="editor-note">${noteHead}<div class="editor-note-quote">${esc(review)}</div>${noteMeta}${fullBlock}</div>`);
  // 核心特点
  const feats = Array.isArray(d.features) ? d.features : [];
  const featInner = feats.length
    ? feats.map((f, i) => `            <div class="feat-item"><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="t"><strong>${esc(f.t)}</strong> ── ${esc(f.d)}</span></div>`).join('\n')
    : `            <div class="feat-item"><span class="t">${esc(p.tagline || '')}</span></div>`;
  sec('核心特点', '价格', `          <h2>核心特点</h2>\n          <div class="feat-list">\n${featInner}\n          </div>`);
  // 价格(去掉编造价格表,定性 + 以官网为准)
  const pricing = (d.pricing || '').trim();
  sec('价格', '替代品', `          <h2>价格</h2>\n          <div class="info-list"><div class="info-row"><span class="k">定价模式</span><span class="v">${esc(p.price_label || '不详')}</span></div></div>\n          <p style="margin-top:10px;color:var(--ink-2);font-size:13px;line-height:1.7;">${esc(pricing || '具体价格以官网为准。')}</p>`);
  // 同类替代(同分类真实产品,排除自己,取 3)
  const sibs = ((ctx.byCat && ctx.byCat[p.category_id]) || []).filter((x) => x.slug !== p.slug).slice(0, 3);
  const altInner = sibs.length
    ? sibs.map((s) => `            <a href="/tools/${esc(s.slug)}" class="alt-card"><div class="alt-card-top"><div class="alt-card-logo"><img src="/public/logos/${esc(s.domain)}.png" alt="${esc(s.name)}"></div><div class="alt-card-name">${esc(s.name)}</div></div><div class="alt-card-desc">${esc(s.tagline || '')}</div></a>`).join('\n')
    : '            <p style="color:var(--ink-3);font-size:13px;">暂无同类。</p>';
  sec('替代品', '讨论', `          <h2>同类替代</h2>\n          <div class="alt-grid">\n${altInner}\n          </div>`);
  return html;
}

/** 国内可用枚举 → 展示文案 */
function domLabel(d) {
  return d === '是' ? '✓ 国内直连' : d === '需代理' ? '⚠ 需代理' : d === '否' ? '✗ 国内不可用' : '— 不详';
}
/** 用真数据重建产品信息侧栏(只放有可靠数据的行) */
function buildInfoList(p) {
  const cat = p.moxie_categories?.name || 'AI 工具';
  const rows = [
    ['分类', esc(cat)],
    ['价格', esc(p.price_label || '不详')],
    ['国内可用', domLabel(p.domestic_available)],
  ];
  if (p.created_at) {
    const d = new Date(p.created_at);
    if (!isNaN(d)) rows.push(['收录于', `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`]);
  }
  if (p.detail?.updated_at) {
    const u = new Date(p.detail.updated_at);
    if (!isNaN(u)) rows.push(['更新于', `${u.getFullYear()}.${String(u.getMonth() + 1).padStart(2, '0')}.${String(u.getDate()).padStart(2, '0')}`]);
  }
  return '<div class="info-list">\n' +
    rows.map(([k, v]) => `            <div class="info-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('\n') +
    '\n          </div>';
}

async function fetchPublishedArticles() {
  const url = `${SUPABASE_URL}/rest/v1/moxie_articles?status=eq.published&select=slug,title,excerpt,category,body_html,cover_url,published_at,read_minutes,related_product_ids&order=published_at.desc&limit=1000`;
  const res = await fetch(url, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  if (!res.ok) throw new Error(`读取文章失败 ${res.status}: ${await res.text()}`);
  return res.json();
}

function buildArticleHead(a, canonical) {
  const desc = a.excerpt || a.title;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    ...(a.excerpt ? { description: a.excerpt } : {}),
    ...(a.cover_url ? { image: [a.cover_url] } : {}),
    ...(a.published_at ? { datePublished: a.published_at, dateModified: a.published_at } : {}),
    author: { '@type': 'Organization', name: 'MOXIE' },
    publisher: { '@type': 'Organization', name: 'MOXIE' },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
  };
  const parts = [
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${esc(a.title)} · MOXIE">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<script type="application/ld+json">${jsonLd(ld)}</script>`,
  ];
  // 【已移除 FAQPage 结构化数据】Google 自 2026-05-07 起不再展示 FAQ 富结果(2026-08 移除支持),
  // 烤它纯惰性。可见「常见问题」内容仍在 body_html 中,不受影响。来源:developers.google.com FAQPage 文档。
  return parts.join('\n');
}

/** 把模板渲染成某篇文章的 SEO 静态页 */
function renderArticle(tpl, a, ctx = {}) {
  const canonical = `${SITE_BASE}/articles/${a.slug}`;
  let html = tpl;
  const checks = [];
  const rep = (from, to, label) => { if (!html.includes(from)) { checks.push(`⚠ 文章未找到[${label}]`); return; } html = html.replace(from, to); };

  html = html
    .replace(/(href|src)="(moxie-[^"]*)"/g, '$1="/$2"')
    .replace(/(href|src)="(public\/[^"]*)"/g, '$1="/$2"');

  rep('<title>DeepSeek V3 中文实测 · MOXIE</title>', `<title>${esc(a.title)} · MOXIE</title>`, 'title');
  rep('</head>', `${buildArticleHead(a, canonical)}\n</head>`, 'head');
  rep('<h1 class="art-title" id="artTitle">加载中…</h1>', `<h1 class="art-title" id="artTitle">${esc(a.title)}</h1>`, 'artTitle');
  rep('<p class="art-excerpt" id="artExcerpt"></p>', `<p class="art-excerpt" id="artExcerpt">${esc(a.excerpt || '')}</p>`, 'artExcerpt');
  rep('<span class="tag" id="artCategory">REVIEW</span>', `<span class="tag" id="artCategory">${esc(a.category || '')}</span>`, 'artCategory');
  // 有 body_html 才烤进正文:给 h2 注入 id(供 TOC 锚点)+ 整段替换 #artBody
  // (连同模板 fallback demo)→ 真正文。空(种子文章)→ 留模板默认,待生成正文后重渲染。
  const toc = [];
  if (a.body_html) {
    let i = 0;
    const bodyWithIds = a.body_html.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/g, (m, attrs, inner) => {
      i++;
      const had = attrs && (attrs.match(/\bid="([^"]*)"/) || [])[1];
      const id = had || `sec-${i}`;
      toc.push({ id, text: inner.replace(/<[^>]+>/g, '').trim() });
      return had ? m : `<h2 id="${id}"${attrs || ''}>${inner}</h2>`;
    });
    const re = /(<article class="art-content" id="artBody">)[\s\S]*?(<\/article>)/;
    if (re.test(html)) html = html.replace(re, (_m, open, close) => `${open}${bodyWithIds}${close}`);
    else checks.push('⚠ 文章未找到[artBody]');
  } else {
    // 空正文:绝不能留模板自带 demo(假 $2.5/M 测试数据)→ 烤一个干净占位
    const ph = '<div style="padding:40px 24px;background:var(--bg-soft);border-radius:12px;color:var(--ink-2);font-size:13.5px;line-height:1.7;"><p style="margin:0">正文整理中,完整内容会在审核通过后补上。</p></div>';
    const re = /(<article class="art-content" id="artBody">)[\s\S]*?(<\/article>)/;
    if (re.test(html)) html = html.replace(re, (_m, open, close) => `${open}${ph}${close}`);
  }

  // 侧栏整段重建:模板自带 demo(目录/本文涉及产品/更多评测)写死且只有 TOC 被客户端 JS 重建,
  // 其余对所有文章常驻错误内容 → prerender 用真数据替换整个 <aside>。
  const aside = buildAside(a, toc, ctx);
  const are = /(<aside class="art-side">)[\s\S]*?(<\/aside>)/;
  if (are.test(html)) html = html.replace(are, (_m, open, close) => `${open}${aside}${close}`);
  else checks.push('⚠ 文章未找到[aside]');

  rep("const slug = new URLSearchParams(location.search).get('slug');", `const slug = ${JSON.stringify(a.slug)};`, 'slug');

  return { html, checks };
}

/** 用真数据组装文章侧栏:目录(真 h2)/ 本文涉及产品(related_product_ids)/ 更多评测(其他文章) */
function buildAside(a, toc, ctx) {
  const blocks = [];
  if (toc.length) {
    const items = toc.map((t, i) => `<li${i === 0 ? ' class="active"' : ''} data-target="#${t.id}">${esc(t.text)}</li>`).join('');
    blocks.push(`<div class="toc-block"><h4>目录</h4><ul class="toc-list">${items}</ul></div>`);
  }
  const rel = (a.related_product_ids || []).map((id) => ctx.productById?.get(id)).filter(Boolean).slice(0, 6);
  if (rel.length) {
    const items = rel.map((p) => {
      const tag = p.moxie_categories?.name || (p.tags && p.tags[0]) || 'AI 工具';
      return `<a href="/tools/${esc(p.slug)}" class="related-prod" style="text-decoration:none;"><div class="related-prod-logo"><img src="/public/logos/${esc(p.domain)}.png" alt=""></div><div><div class="related-prod-name">${esc(p.name)}</div><div class="related-prod-tag">${esc(tag)}</div></div></a>`;
    }).join('');
    blocks.push(`<div class="related-block"><h4>本文涉及产品</h4>${items}</div>`);
  }
  const more = (ctx.allArticles || []).filter((x) => x.slug !== a.slug).slice(0, 3);
  if (more.length) {
    const items = more.map((x, i) => `<a href="/articles/${esc(x.slug)}" style="font-size:12.5px;color:var(--ink-1);display:block;padding:6px 0;${i < more.length - 1 ? 'border-bottom:1px solid var(--line-2);' : ''}">${esc(x.title)}</a>`).join('');
    blocks.push(`<div class="tools-block"><h4>更多评测</h4>${items}</div>`);
  }
  return blocks.join('\n');
}

async function fetchNews() {
  const url = `${SUPABASE_URL}/rest/v1/moxie_news?select=id,title,url,source,tag,published_at,summary&order=published_at.desc.nullslast&limit=200`;
  const res = await fetch(url, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  if (!res.ok) throw new Error(`读取快讯失败 ${res.status}: ${await res.text()}`);
  return res.json();
}

/** 快讯详情:预渲染静态页(内容烤入,不依赖现场请求) */
function buildNewsPage(n) {
  const canonical = `${SITE_BASE}/news/${n.id}`;
  const src = n.source || n.tag || '';
  const sum = (n.summary || '').trim();
  const d = n.published_at ? new Date(n.published_at) : null;
  const date = d && !isNaN(d) ? `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}` : '';
  const desc = (sum || n.title).slice(0, 150);
  const ld = { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: n.title, ...(sum ? { description: sum } : {}), ...(n.published_at ? { datePublished: n.published_at } : {}), author: { '@type': 'Organization', name: src }, publisher: { '@type': 'Organization', name: 'MOXIE' }, mainEntityOfPage: { '@type': 'WebPage', '@id': canonical } };
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/public/moxie-mark.png?v=20260525-01">
<title>${esc(n.title)} · MOXIE 快讯</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(n.title)} · MOXIE">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}"><link rel="stylesheet" href="/moxie-styles.css?v=20260617-01">
<script type="application/ld+json">${jsonLd(ld)}</script>
<style>
  .nv{height:60px;border-bottom:1px solid var(--line);display:flex;align-items:center}
  .nv .container{display:flex;align-items:center;justify-content:space-between}
  .nv a.brand{font-weight:600;color:var(--ink);text-decoration:none;font-size:16px}
  .nv-links{display:flex;align-items:center;gap:22px}
  .nv-links a{color:var(--ink-1);text-decoration:none;font-size:13.5px}
  .nv-links a:hover{color:var(--accent)}
  .ni-foot{border-top:1px solid var(--line);margin-top:48px}
  .ni-foot .container{display:flex;align-items:center;justify-content:space-between;min-height:64px;flex-wrap:wrap;gap:10px;font-size:12.5px;color:var(--ink-3)}
  .ni-foot a{font-size:12.5px;color:var(--ink-3);text-decoration:none}
  .ni-foot-links{display:flex;gap:18px}
  .ni-foot-links a:hover{color:var(--accent)}
  @media(max-width:640px){.nv-links a:not(.ni-back){display:none}}
  .ni-wrap{max-width:720px;margin:0 auto;padding:56px 20px 90px}
  .ni-meta{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--ink-3);margin-bottom:16px}
  .ni-src{color:#F53F3F;font-weight:600}
  .ni-wrap h1{font-size:28px;line-height:1.45;font-weight:600;color:var(--ink);letter-spacing:-.01em;margin-bottom:22px}
  .ni-sum{font-size:15.5px;line-height:1.9;color:var(--ink-1);background:var(--bg-soft);border-radius:12px;padding:20px 22px;margin-bottom:28px}
  .ni-sum.empty{color:var(--ink-3)}
  .ni-actions{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  .ni-orig{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:11px 22px;border-radius:9999px;font-size:14px;font-weight:500}
  .ni-orig:hover{background:var(--accent-d)}
  .ni-back{color:var(--ink-2);text-decoration:none;font-size:13px}
  .ni-back:hover{color:var(--accent)}
  .ni-note{margin-top:30px;font-size:12px;color:var(--ink-3);line-height:1.7;border-top:1px solid var(--line);padding-top:16px}
</style>
</head>
<body>
<nav class="nv"><div class="container">
  <a class="brand" href="/moxie-preview.html">MOXIE</a>
  <div class="nv-links">
    <a href="/moxie-preview.html">榜单</a>
    <a href="/moxie-business.html">商业落地</a>
    <a href="/moxie-categories.html">分类</a>
    <a href="/moxie-blog.html">文章</a>
    <a class="ni-back" href="/moxie-news.html">← 全部快讯</a>
  </div>
</div></nav>
<div class="ni-wrap">
  <div class="ni-meta"><span class="ni-src">${esc(src)}</span><span>·</span><span>${esc(date)}</span><span>·</span><span>AI 快讯</span></div>
  <h1>${esc(n.title)}</h1>
  <div class="ni-sum${sum ? '' : ' empty'}">${sum ? esc(sum) : '本条快讯暂无摘要,点下方阅读原文。'}</div>
  <div class="ni-actions"><a class="ni-orig" href="${esc(n.url)}" target="_blank" rel="noopener">阅读原文 ↗</a><a class="ni-back" href="/moxie-news">← 全部快讯</a></div>
  <div class="ni-note">摘要来自来源媒体(${esc(src)})的公开 RSS,版权归原作者。MOXIE 仅做聚合索引,完整内容请以原文为准。</div>
</div>
<footer class="ni-foot"><div class="container">
  <span>© 2024 — 2026 MOXIE · AI 选型决策平台</span>
  <div class="ni-foot-links"><a href="/moxie-preview.html">榜单</a><a href="/moxie-categories.html">分类</a><a href="/moxie-blog.html">文章</a><a href="/moxie-news.html">快讯</a><a href="/moxie-about.html">关于</a></div>
</div></footer>
</body>
</html>`;
}

async function main() {
  console.log(`\n🖨  Phase 1.1/1.3 预渲染 · base=${SITE_BASE}\n`);
  const warned = new Set();

  // 产品页
  const ptpl = readFileSync(join(ROOT, 'moxie-product.html'), 'utf8');
  const products = await fetchPublishedProducts();
  // 同分类映射(同类替代用;products 已按 vote_count 降序)
  const byCat = {};
  products.forEach((p) => { (byCat[p.category_id] = byCat[p.category_id] || []).push(p); });
  mkdirSync(OUT_DIR, { recursive: true });
  let pn = 0;
  for (const p of products) {
    const { html, checks } = renderProduct(ptpl, p, { byCat });
    checks.forEach((c) => warned.add(c));
    writeFileSync(join(OUT_DIR, `${p.slug}.html`), html, 'utf8');
    pn++;
  }
  console.log(`✓ 产品页 ${pn} → tools/<slug>.html`);
  // 清理孤儿页:删掉已不在 published 列表的旧 tool 页(如被 reject 的产品)。
  // orphansToPrune 带炸站下限保护:读库返回空/将删过半时返回 null → 保守跳过,绝不删光全站。
  const keepFiles = new Set(products.map((p) => `${p.slug}.html`));
  const existingHtml = readdirSync(OUT_DIR).filter((f) => f.endsWith('.html'));
  const toPrune = orphansToPrune(existingHtml, keepFiles);
  if (toPrune === null) {
    console.warn(`⚠ 跳过孤儿页清理(疑似读库异常):published=${keepFiles.size} / 现有 ${existingHtml.length} 页,保守不删`);
  } else {
    for (const f of toPrune) rmSync(join(OUT_DIR, f));
    if (toPrune.length) console.log(`✓ 清理孤儿产品页 ${toPrune.length} 个`);
  }

  // 文章页(侧栏要用产品数据 → 建 id→product 映射)
  const atpl = readFileSync(join(ROOT, 'moxie-article.html'), 'utf8');
  const articles = await fetchPublishedArticles();
  const productById = new Map(products.map((p) => [p.id, p]));
  mkdirSync(OUT_ARTICLES, { recursive: true });
  let an = 0;
  for (const a of articles) {
    const { html, checks } = renderArticle(atpl, a, { productById, allArticles: articles });
    checks.forEach((c) => warned.add(c));
    writeFileSync(join(OUT_ARTICLES, `${a.slug}.html`), html, 'utf8');
    an++;
  }
  console.log(`✓ 文章页 ${an} → articles/<slug>.html`);

  // 快讯页(预渲染静态页)。先清旧 → 写当前。
  // 炸站下限保护:fetchNews 返回空(200 空读/库异常)时**绝不清空**,保留现有 news 页;
  // 否则配合 refresh.yml 的 `git add news/` 会把整类 news 删光 + 提交 + 部署。
  const news = await fetchNews();
  if (news.length === 0) {
    console.warn('⚠ 快讯读取为空,跳过 news 重渲染(保留现有页,防空读删光全站 news)');
  } else {
    rmSync(OUT_NEWS, { recursive: true, force: true });
    mkdirSync(OUT_NEWS, { recursive: true });
    for (const n of news) writeFileSync(join(OUT_NEWS, `${n.id}.html`), buildNewsPage(n), 'utf8');
    console.log(`✓ 快讯页 ${news.length} → news/<id>.html`);
  }

  if (warned.size) console.log('   模板替换告警:', [...warned].join(' '));
  console.log('');
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
