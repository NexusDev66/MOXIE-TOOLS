#!/usr/bin/env node
/**
 * 同源数据快照(大陆访问救星)
 *
 * 背景:镜像站静态资源走 github.io(国内可达),但页面数据原本是浏览器**实时连
 * kyiqgvxvbxktiygohuqh.supabase.co**(Cloudflare,大陆经常连不上/极慢)→ 首页等列表页"数据出不来"。
 * 本脚本在构建时把列表所需数据导成一份**同源静态 JSON**(public/data/snapshot.json),
 * 由 moxie-supabase.js 的 MoxieDB 读取层**优先读快照**(读不到再回退实时 Supabase)。
 * 这样国内用户不依赖连 Supabase 就能看到真实最新数据;每日 cron 重建 → 数据天天刷新。
 *
 * 跑法:node --env-file=.env.local cli/snapshot.js
 * 读数据用 anon key(只读 published),不需要 service key。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY'); process.exit(1); }

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'public', 'data');

async function q(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function main() {
  console.log('\n📦 生成同源数据快照(public/data/snapshot.json)\n');

  // 产品:select=* 保证渲染用到的字段都在;只剥离重型 detail(详情页是预渲染,客户端列表用不到)
  const productsRaw = await q('moxie_products?status=eq.published&select=*,moxie_categories(id,name,slug,group_name)&order=weight_score.desc.nullslast&limit=2000');
  const products = productsRaw.map(({ detail, ...rest }) => rest); // 去掉 detail 减体积
  const categories = await q('moxie_categories?select=*&order=sort_order.asc');
  // 文章列表:不含正文 body_html(详情页预渲染),只留卡片要用的字段
  const articles = await q('moxie_articles?status=eq.published&select=slug,title,excerpt,category,cover_url,published_at,read_minutes,related_product_ids&order=published_at.desc&limit=2000');
  const news = await q('moxie_news?select=id,title,url,source,tag,published_at,summary,score,category,summary_zh&order=published_at.desc.nullslast&limit=60');
  let voices = [];
  try { voices = await q('moxie_voices?select=person,role,take,importance,news_id,published_at&order=importance.desc&limit=60'); } catch { voices = []; }

  const snapshot = {
    generated_at: new Date().toISOString(),
    counts: { products: products.length, categories: categories.length, articles: articles.length, news: news.length, voices: voices.length },
    products, categories, articles, news, voices,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, 'snapshot.json');
  writeFileSync(file, JSON.stringify(snapshot), 'utf8');
  const kb = Math.round(Buffer.byteLength(JSON.stringify(snapshot)) / 1024);
  console.log(`✓ 快照已写:产品 ${products.length} · 分类 ${categories.length} · 文章 ${articles.length} · 快讯 ${news.length} · 观点 ${voices.length}(${kb} KB)`);
  console.log('  → public/data/snapshot.json\n');
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
