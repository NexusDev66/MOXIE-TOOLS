#!/usr/bin/env node
/**
 * IndexNow 自动提交 —— 把站点 URL 推给搜索引擎(Bing/Yandex 等),加速收录
 *
 * 读 sitemap.xml 取全部 <loc>,按 IndexNow 协议一次性提交给 api.indexnow.org。
 * Google 不用 IndexNow,但 Bing/Yandex 等会即时抓取;比纯等自然爬取快很多。
 *
 * 校验:站点根必须能访问 https://<host>/<key>.txt 且内容 = key(本仓库已放该文件,
 * 随静态站一起部署)。host 取 sitemap 里的域名(= SITE_BASE_URL,默认 www.latemai.com)。
 *
 * 跑法:node cli/indexnow.js [--dry-run]   (无需 DB/LLM key)
 * 可选 env:INDEXNOW_KEY(默认用下方常量)。
 */

import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.INDEXNOW_KEY || '5e9f4171e1f9473b239b0b0b698d5585';
const DRY_RUN = process.argv.includes('--dry-run');
const SITEMAP = path.join(process.cwd(), 'sitemap.xml');

async function main() {
  console.log(`\n📨 IndexNow 提交${DRY_RUN ? ' [DRY-RUN]' : ''}\n`);
  if (!fs.existsSync(SITEMAP)) { console.error('❌ 未找到 sitemap.xml,请先 node cli/sitemap.js'); process.exit(1); }
  const xml = fs.readFileSync(SITEMAP, 'utf8');
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim()).filter(Boolean);
  if (!urls.length) { console.log('sitemap 里没有 URL,跳过'); return; }

  let host;
  try { host = new URL(urls[0]).host; } catch { console.error('❌ sitemap URL 解析失败'); process.exit(1); }
  const keyLocation = `https://${host}/${KEY}.txt`;
  console.log(`host=${host} · URL ${urls.length} 条 · keyLocation=${keyLocation}`);

  if (DRY_RUN) { console.log('[dry] 不提交。前 3 条:', urls.slice(0, 3).join(' | ')); return; }

  // IndexNow 单次上限 10000 条;这里量小,一次发完
  const body = { host, key: KEY, keyLocation, urlList: urls.slice(0, 10000) };
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  // IndexNow:200/202 = 收到;其他状态打印但不抛(放进流水线时 continue-on-error)
  console.log(`IndexNow 返回 ${res.status} ${res.statusText}`);
  if (res.status !== 200 && res.status !== 202) {
    console.log('提示:若 403/422,多半是 key 文件未在站点根可访问,或 host 与部署域名不一致。');
    console.log((await res.text()).slice(0, 200));
  } else {
    console.log(`✓ 已提交 ${body.urlList.length} 条 URL`);
  }
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
