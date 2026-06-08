#!/usr/bin/env node
/**
 * 每日 AI 快讯抓取(latemai)
 *
 * 拉多个 RSS 源 → 解析 → 去重 → 写 moxie_news(service key)。首页客户端 anon 读渲染。
 * 无第三方依赖:用轻量正则解析 RSS/Atom。多源容错(单源失败不影响其他)。
 *
 * 跑法:node --env-file=.env.local cli/fetch-news.js [--limit 30] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。
 * 源可用 env NEWS_FEEDS 覆盖(逗号分隔 url|来源名,如 "https://x/feed|某站,https://y/rss|另一站")。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const LIMIT = Math.max(5, Number((process.argv[process.argv.indexOf('--limit') + 1]) || 30) || 30);
const DRY_RUN = process.argv.includes('--dry-run');
const KEEP = 60; // 库里最多保留多少条(超出删旧)

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

// 默认源(中文 AI/科技;可被 NEWS_FEEDS 覆盖)。单源失败自动跳过。
const DEFAULT_FEEDS = [
  'https://www.qbitai.com/feed|量子位',
  'https://www.jiqizhixin.com/rss|机器之心',
  'https://www.solidot.org/index.rss|Solidot',
  'https://36kr.com/feed-newsflash|36氪',
];
const FEEDS = (process.env.NEWS_FEEDS
  ? process.env.NEWS_FEEDS.split(',')
  : DEFAULT_FEEDS
).map((s) => { const [url, name] = s.split('|'); return { url: url.trim(), name: (name || '').trim() || hostOf(url) }; });

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '源'; } }
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function pick(block, tags) {
  for (const t of tags) {
    const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}
function pickLink(block) {
  // RSS <link>url</link>;Atom <link href="url"/>
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rss && decode(rss[1])) return decode(rss[1]);
  const atom = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atom) return atom[1];
  return '';
}

function parseFeed(xml, sourceName) {
  const out = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = decode(pick(b, ['title']));
    const url = pickLink(b).trim();
    const dateRaw = decode(pick(b, ['pubDate', 'published', 'updated', 'dc:date']));
    if (!title || !url) continue;
    let published_at = null;
    if (dateRaw) { const d = new Date(dateRaw); if (!isNaN(d)) published_at = d.toISOString(); }
    out.push({ title: title.slice(0, 200), url, source: sourceName, tag: sourceName, published_at });
  }
  return out;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (MoxieNewsBot)' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.log(`  ⚠ ${feed.name} HTTP ${res.status},跳过`); return []; }
    const xml = await res.text();
    const items = parseFeed(xml, feed.name);
    console.log(`  ✓ ${feed.name}:${items.length} 条`);
    return items;
  } catch (e) { console.log(`  ⚠ ${feed.name} 失败(${e.message}),跳过`); return []; }
}

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function main() {
  console.log(`\n📰 抓取 AI 快讯${DRY_RUN ? ' [DRY-RUN]' : ''} · ${FEEDS.length} 源\n`);
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();

  // 去重(按 url)+ 按时间倒序 + 截断
  const seen = new Set();
  const items = all
    .filter((x) => { if (seen.has(x.url)) return false; seen.add(x.url); return true; })
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
    .slice(0, LIMIT);

  if (!items.length) { console.log('\n⚠ 所有源都没拿到条目(可能网络/源失效)。库未改动。'); return; }
  console.log(`\n合并去重后 ${items.length} 条,最新:${items[0].title}`);

  if (DRY_RUN) { items.slice(0, 8).forEach((x) => console.log(`  · [${x.tag}] ${x.title}`)); return; }

  // upsert(url 唯一,merge 更新)
  await sb('/moxie_news?on_conflict=url', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: items });
  console.log(`✓ 已写入 ${items.length} 条`);

  // 删旧:只保留最新 KEEP 条
  const keep = await sb(`/moxie_news?select=id&order=published_at.desc.nullslast&limit=${KEEP}`);
  if (keep && keep.length === KEEP) {
    const minId = Math.min(...keep.map((r) => r.id));
    // 删除不在最新 KEEP 内的(按 published_at 排序后,最旧的)—— 用 id 不可靠,改用时间阈值
    const oldest = await sb(`/moxie_news?select=published_at&order=published_at.desc.nullslast&offset=${KEEP - 1}&limit=1`);
    if (oldest && oldest[0] && oldest[0].published_at) {
      await sb(`/moxie_news?published_at=lt.${encodeURIComponent(oldest[0].published_at)}`, { method: 'DELETE', prefer: 'return=minimal' });
      console.log(`✓ 已清理 ${oldest[0].published_at.slice(0, 10)} 之前的旧条目(保留最新 ${KEEP})`);
    }
    void minId;
  }
  console.log('');
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
