#!/usr/bin/env node
/**
 * Phase 3 · 新锐工具发现(Product Hunt)— 探查阶段
 *
 * 目前只做 --probe:抓 PH feed,打印结构 + 尝试解析出工具真实域名,
 * 判断 RSS 够不够(还是需要 PH API token)。确认后再补 enrich/gate/入库。
 *
 * 跑法:node cli/discover-tools.js --probe   (在 GitHub Actions 上跑,本机连不上 PH)
 */

const PROBE = process.argv.includes('--probe');

const FEEDS = [
  'https://www.producthunt.com/feed',
  'https://www.producthunt.com/feed?category=artificial-intelligence',
];

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}
function tag(block, t) { const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i')); return m ? decode(m[1]) : ''; }

/** 从 PH 帖子页 HTML 里找工具真实域名:优先 /r/ 跳转链接,其次正文外链 */
async function resolveDomain(phUrl) {
  try {
    const res = await fetch(phUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return `(页 ${res.status})`;
    const html = await res.text();
    // PH 外链通常是 producthunt.com/r/<hash> 或页面里直接出现目标站
    const r = html.match(/https?:\/\/www\.producthunt\.com\/r\/[A-Za-z0-9_]+/);
    if (r) {
      const follow = await fetch(r[0], { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const loc = follow.headers.get('location');
      if (loc) { try { return new URL(loc).hostname.replace(/^www\./, ''); } catch { return loc.slice(0, 60); } }
      return '(/r/ 无 location)';
    }
    return '(未找到 /r/ 链接)';
  } catch (e) { return `(解析失败 ${e.message})`; }
}

async function probe() {
  console.log('\n🔎 Product Hunt 探查\n');
  for (const url of FEEDS) {
    console.log(`=== ${url} ===`);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MoxieDiscover)' }, signal: AbortSignal.timeout(15000) });
      console.log(`  HTTP ${res.status} · content-type ${res.headers.get('content-type')}`);
      if (!res.ok) { console.log('  (跳过)\n'); continue; }
      const xml = await res.text();
      const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
      console.log(`  条目数:${blocks.length}`);
      for (const b of blocks.slice(0, 3)) {
        const title = tag(b, 'title');
        const link = tag(b, 'link') || (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || '';
        const desc = tag(b, 'description').replace(/<[^>]+>/g, '').slice(0, 80);
        console.log(`  • ${title}`);
        console.log(`    ph链接: ${link}`);
        console.log(`    简介: ${desc}`);
        if (link.includes('producthunt.com')) console.log(`    解析域名: ${await resolveDomain(link)}`);
      }
      console.log('');
    } catch (e) { console.log(`  失败:${e.message}\n`); }
  }
}

if (!PROBE) { console.error('当前仅支持 --probe(探查)。'); process.exit(1); }
probe().catch((e) => { console.error('❌', e.message); process.exit(1); });
