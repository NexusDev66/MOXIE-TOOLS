#!/usr/bin/env node
/**
 * Phase 1.2 · 生成 sitemap.xml + robots.txt
 *
 * 读 published 产品 → 输出根目录 sitemap.xml(首页 + 每个 /tools/<slug>)+ robots.txt。
 * 产品详情页 /tools/<slug> 由 cli/prerender.js 预渲染(Phase 1.1)。
 * 文章页待 Phase 1.3 预渲染后再加进 sitemap。
 *
 * 跑法:node --env-file=.env.local cli/sitemap.js
 * 读数据用 anon key(只读 published)。canonical 域名:env SITE_BASE_URL(默认 https://www.latemai.com)。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SITE_BASE = (process.env.SITE_BASE_URL || 'https://www.latemai.com').replace(/\/+$/, '');
if (!SUPABASE_URL || !ANON) {
  console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY(.env.local)');
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const today = new Date().toISOString().slice(0, 10);

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function main() {
  console.log(`\n🗺  Phase 1.2 sitemap · base=${SITE_BASE}\n`);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/moxie_products?status=eq.published&select=slug,updated_at&order=vote_count.desc&limit=2000`,
    { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } },
  );
  if (!res.ok) throw new Error(`读取产品失败 ${res.status}: ${await res.text()}`);
  const products = await res.json();
  console.log(`   published 产品:${products.length}`);

  const ares = await fetch(
    `${SUPABASE_URL}/rest/v1/moxie_articles?status=eq.published&select=slug,published_at&order=published_at.desc&limit=2000`,
    { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } },
  );
  const articles = ares.ok ? await ares.json() : [];
  console.log(`   published 文章:${articles.length}`);

  const urls = [
    { loc: `${SITE_BASE}/`, lastmod: today, priority: '1.0', changefreq: 'daily' },
    ...products.map((p) => ({
      loc: `${SITE_BASE}/tools/${p.slug}`,
      lastmod: (p.updated_at || '').slice(0, 10) || today,
      priority: '0.8',
      changefreq: 'weekly',
    })),
    ...articles.map((a) => ({
      loc: `${SITE_BASE}/articles/${a.slug}`,
      lastmod: (a.published_at || '').slice(0, 10) || today,
      priority: '0.6',
      changefreq: 'monthly',
    })),
  ];

  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${xmlEsc(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`,
    )
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  writeFileSync(join(ROOT, 'sitemap.xml'), xml, 'utf8');
  console.log(`✓ sitemap.xml(${urls.length} 个 URL)`);

  const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_BASE}/sitemap.xml\n`;
  writeFileSync(join(ROOT, 'robots.txt'), robots, 'utf8');
  console.log(`✓ robots.txt(指向 sitemap)\n`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
