#!/usr/bin/env node
/**
 * MOXIE Trend Scanner · 每周扫海外目录站，产出频次榜候选
 *
 * 合规原则:
 *   - 只存归一化 URL + 出现次数 + 来源站名
 *   - 不存原文描述 / 评论 / 排名内容
 *   - 工具的官网 URL + 名字是事实数据（不受版权保护）
 *   - 给 admin 审核入口，人工写中文介绍后才进 moxie_products
 *
 * 用法:
 *   SUPABASE_SERVICE_KEY=xxx node cli/trend-scanner.js [--dry-run]
 *
 * 在 GitHub Actions 里通过 secrets 注入 key
 */

import { isAllowed } from './scanner-lib/robots.js';
import { uaForKey } from './scanner-lib/ua-pool.js';
import { throttle } from './scanner-lib/rate-limit.js';
import { recordFailure, recordSuccess, sendFeishuAlert, FEISHU_FAIL_THRESHOLD } from './scanner-lib/feishu.js';
import { extractProductLinks } from './scanner-lib/html-extract.js';
import { prefilter } from './clean-gate.mjs';

const SUPABASE_URL = 'https://sqvohgcwzhhsvkmyesvs.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const REQ_INTERVAL_MS = 1000;   // T4 AC-3: 同域名 ≥ 1s/req

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_KEY env 必须设');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (compatible; MoxieTrendScanner/1.0; +https://latemai.com/install/agent.md)';

const runId = (() => {
  const d = new Date();
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d - new Date(Date.UTC(y, 0, 1))) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2,'0')}-${d.toISOString().slice(0,10)}`;
})();

console.log(`\n🛰  MOXIE Trend Scanner · run ${runId}${DRY_RUN ? ' [DRY-RUN]' : ''}\n`);

// ───── Sources ─────
// 【方向纠偏 2026-06-15】latemai 是中文 AI 工具站,旧版全是海外独立开发者/SaaS 发布站
// (launch.cab/neeed/fazier…)→ 抓出 306 灰产杂牌,毫无价值。改为以中文 AI 工具导航为主,
// 仅保留 ProductHunt 作为全球 AI 新品信号。入库前再过 prefilter + 完整 gate + AI 层。
// 【需核实】下列站点的 robots 许可与可抓性,上线首跑后按真实产出调整;抓不到/被禁的替换。
const SOURCES = [
  // 全球 AI 新品信号(真 RSS)
  { site: 'producthunt.com',    type: 'rss',  url: 'https://www.producthunt.com/feed' },

  // 中文 AI 工具导航(HTML;robots 校验 + UA 池 + 1s 限速由合规层保证)
  { site: 'ai-bot.cn',          type: 'html', url: 'https://ai-bot.cn/' },          // AI 工具集(国内最大之一)
  { site: 'hao.ai-bot.cn',      type: 'html', url: 'https://hao.ai-bot.cn/' },      // AI 工具集·导航
  { site: 'www.aigc.cn',        type: 'html', url: 'https://www.aigc.cn/' },        // AIGC 工具导航
  { site: 'www.toolpedia.cn',   type: 'html', url: 'https://www.toolpedia.cn/' },   // 中文 AI 工具百科
];

// ───── helpers ─────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    u.hash = '';
    let path = u.pathname.replace(/\/$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch { return null; }
}

function domainOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; }
}

/* 归一化产品名做 dedupe key
   "Cursor AI - Code Editor | Pro" → "cursor-ai-code-editor-pro"
   "DeepSeek V3"                  → "deepseek-v3"
   截断 title 在第一个 | 或 - 后面太长的尾巴避免 tagline 干扰
*/
function productKeyFromTitle(rawTitle) {
  if (!rawTitle) return null;
  // 取 | 或 — 前的主名（很多 RSS title = "ProductName | Tagline"）
  let s = rawTitle.split(/[|—–]/)[0].trim();
  // 也去掉常见的子标 ": xxx" 之类（保留主名）
  s = s.split(/[:：]/)[0].trim();
  // 归一化: 小写 + 非字母数字 → -
  s = s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length < 2 || s.length > 60) return null;
  return s;
}

function isSelf(url, sourceSite) {
  const d = domainOf(url);
  return d && (d === sourceSite || d.endsWith('.' + sourceSite));
}

// ───── parsers ─────
async function fetchText(url, { ua = UA, accept = 'application/xml,text/xml,*/*', timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseRssItems(xml) {
  // 简易 RSS/Atom parser，只取 <link> 和 <title>
  const items = [];
  // RSS <item>
  for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const link = (block.match(/<link[^>]*>([^<]+)<\/link>/i) || block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1];
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1];
    if (link) items.push({ link: link.trim(), title: (title || '').trim() });
  }
  // Atom <entry>
  for (const m of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const block = m[1];
    const link = (block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1];
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1];
    if (link) items.push({ link: link.trim(), title: (title || '').trim() });
  }
  return items;
}

function parseSitemap(xml, linkPrefix) {
  const items = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const block = m[1];
    const loc = (block.match(/<loc[^>]*>([^<]+)<\/loc>/i) || [])[1];
    const lastmod = (block.match(/<lastmod[^>]*>([^<]+)<\/lastmod>/i) || [])[1];
    if (!loc) continue;
    if (linkPrefix && !loc.startsWith(linkPrefix)) continue;
    // 只要最近 7 天内有变更的
    if (lastmod) {
      const d = new Date(lastmod);
      if (Date.now() - d.getTime() > 7 * 86400000) continue;
    }
    items.push({ link: loc.trim(), title: '' });
  }
  return items;
}

// ───── 拉每个 source ─────
async function scanSource(s) {
  console.log(`  ⬇ ${s.site} (${s.type})...`);
  const ua = uaForKey(s.site);   // T4 AC-3: 每站稳定取一个 UA（5 个池里）

  // ── T4 AC-2: robots.txt 校验（注入 fetchText，带本站 UA）·一轮一次 ──
  let pathname = '/';
  try { pathname = new URL(s.url).pathname || '/'; } catch { /* keep */ }
  const allowed = await isAllowed(
    s.site,
    pathname,
    (u) => fetchText(u, { ua, accept: 'text/plain,*/*', timeoutMs: 8000 }),
    console.log,
  );
  if (!allowed) {
    console.log(`    ⊘ robots disallow ${pathname}，跳过`);
    return { ok: false, error: `robots disallow ${pathname}`, items: [], skipped: true };
  }

  const accept = s.type === 'html'
    ? 'text/html,application/xhtml+xml,*/*;q=0.8'
    : 'application/xml,text/xml,*/*';

  // ── T4 AC-4: 单源单轮内连抓失败 FEISHU_FAIL_THRESHOLD(=3) 次才告警 ──
  // failCounts 是进程内计数，weekly 跑每次都是全新进程，跨轮累积不到阈值；
  // 改成"本轮重试 3 次都失败"来满足阈值：既避免单次网络抖动误报，
  // 又保证源真挂了当轮就告警。每次重试都先过同域限速（AC-3）。
  let lastErr;
  for (let attempt = 1; attempt <= FEISHU_FAIL_THRESHOLD; attempt++) {
    await throttle(s.site, REQ_INTERVAL_MS);   // T4 AC-3: 同域名 ≥ 1s 限速
    try {
      const body = await fetchText(s.url, { ua, accept });

      let items;
      if (s.type === 'rss') items = parseRssItems(body);
      else if (s.type === 'sitemap') items = parseSitemap(body, s.linkPrefix);
      else if (s.type === 'html') items = extractProductLinks(body, s.url, s.site);
      else throw new Error('unknown type');

      // RSS/sitemap: <link> 是目录站详情页；HTML: 抽出的是产品官网外链
      const candidates = items
        .map(it => {
          const url = normalizeUrl(it.link);
          const productKey = productKeyFromTitle(it.title);
          if (!url || !productKey) return null;
          return { url, title: it.title, productKey, sourceUrl: it.link };
        })
        .filter(Boolean)
        .filter(c => {
          // HTML 抓的是外部官网，根域名也有效；RSS/sitemap 要 path 长度 > 1
          if (s.type === 'html') return true;
          try { return new URL(c.url).pathname.length > 1; } catch { return false; }
        });

      console.log(`    ✓ ${candidates.length} items`);
      recordSuccess(s.site);   // 成功 → 清零失败计数
      return { ok: true, items: candidates };
    } catch (e) {
      lastErr = e;
      console.log(`    ✗ 第 ${attempt}/${FEISHU_FAIL_THRESHOLD} 次失败: ${e.message}`);
      // 每次失败累加；达阈值时 recordFailure 内部自动发飞书告警 + 清零
      await recordFailure(s.site, e.message, console.log);
    }
  }
  return { ok: false, error: lastErr?.message || 'unknown', items: [] };
}

// ───── upsert 到 Supabase ─────
async function upsertCandidates(items, sourceSite, runId) {
  if (DRY_RUN) {
    console.log(`    [dry] would upsert ${items.length} from ${sourceSite}`);
    return { newCands: 0, newSrcs: items.length };
  }
  let newCands = 0;
  let newSrcs = 0;
  let prefiltered = 0;
  for (const it of items) {
    const domain = domainOf(it.url);
    if (!domain) continue;

    // 入口预过滤:目录站域名 / 灰产 TLD 直接丢,别堆进候选表(根因:旧版没过闸 → 306 灰产)
    const pf = prefilter(it.title || '', domain);
    if (pf.reject) { prefiltered++; continue; }

    // 1. upsert candidate by product_key (跨站 dedupe 的真 key)
    const candidate = await sb(`/moxie_trend_candidates?on_conflict=product_key`, {
      method: 'POST',
      prefer: 'return=representation,resolution=merge-duplicates',
      body: [{
        product_key: it.productKey,
        tool_url: it.url,
        tool_domain: domain,
        tool_name_hint: it.title || null,
        last_seen_at: new Date().toISOString(),
      }],
    });
    const candId = candidate[0]?.id;
    if (!candId) continue;
    if (candidate[0].occurrence_count === 1 && candidate[0].first_seen_at === candidate[0].last_seen_at) newCands++;

    // 2. upsert source link (unique on candidate_id + source_site)
    try {
      await sb(`/moxie_trend_sources?on_conflict=candidate_id,source_site`, {
        method: 'POST',
        prefer: 'return=minimal,resolution=ignore-duplicates',
        body: [{
          candidate_id: candId,
          source_site: sourceSite,
          source_url: it.sourceUrl,
          source_title: it.title || null,
          scan_run_id: runId,
        }],
      });
      newSrcs++;
    } catch (e) {
      // ignore unique constraint，可能这个候选 × 这个站已经记录过
    }
  }
  if (prefiltered) console.log(`    (预过滤丢弃 ${prefiltered} 条目录站/灰产)`);
  return { newCands, newSrcs, prefiltered };
}

// ───── main ─────
(async () => {
  const startedAt = new Date().toISOString();
  const errors = {};
  let totalOk = 0;
  let totalItems = 0;
  let totalNewCands = 0;

  // create run row
  if (!DRY_RUN) {
    await sb('/moxie_trend_scan_runs', {
      method: 'POST',
      body: [{ id: runId, started_at: startedAt, total_sources_tried: SOURCES.length }],
      prefer: 'return=minimal',
    }).catch(() => {});  // 如果 id 已存在则忽略
  }

  for (const s of SOURCES) {
    const { ok, items, error } = await scanSource(s);
    if (!ok) { errors[s.site] = error; continue; }
    totalOk++;
    totalItems += items.length;
    const { newCands } = await upsertCandidates(items, s.site, runId);
    totalNewCands += newCands;
  }

  // finalize run
  if (!DRY_RUN) {
    await sb(`/moxie_trend_scan_runs?id=eq.${runId}`, {
      method: 'PATCH',
      body: {
        finished_at: new Date().toISOString(),
        total_sources_ok: totalOk,
        total_items_found: totalItems,
        total_new_candidates: totalNewCands,
        source_errors: errors,
      },
      prefer: 'return=minimal',
    }).catch(e => console.warn('finalize error:', e.message));
  }

  console.log(`\n✓ Done · ${totalOk}/${SOURCES.length} sources OK · ${totalItems} items · ${totalNewCands} new candidates`);

  // T4 AC-4: 整轮跑完，若失败源 ≥ 半数，发一条飞书运行汇总告警
  const errSites = Object.keys(errors);
  if (errSites.length >= Math.ceil(SOURCES.length / 2)) {
    await sendFeishuAlert(
      `🛰 MOXIE Trend Scanner 运行汇总告警\n` +
      `run ${runId}\n` +
      `${totalOk}/${SOURCES.length} 源 OK，${errSites.length} 源失败\n` +
      `失败源: ${errSites.join(', ')}`,
      console.log,
    );
  }

  if (errSites.length) {
    console.log(`\n⚠ Errors:`);
    for (const [site, msg] of Object.entries(errors)) console.log(`  ${site}: ${msg}`);
  }

  // 输出累计 Top 10 频次榜
  if (!DRY_RUN) {
    const top = await sb(`/moxie_trend_candidates?status=eq.pending&occurrence_count=gte.2&order=occurrence_count.desc,last_seen_at.desc&limit=10&select=product_key,tool_name_hint,occurrence_count`);
    if (top.length) {
      console.log(`\n🏆 跨站频次榜 (≥2 个站收录的工具) Top ${top.length}:`);
      top.forEach((t, i) => {
        console.log(`  ${i+1}. [${t.occurrence_count} sources] ${t.tool_name_hint || t.product_key}`);
      });
    } else {
      console.log(`\n📊 暂无跨站频次（需要多次 scan 累积）`);
      const samples = await sb(`/moxie_trend_candidates?order=last_seen_at.desc&limit=5&select=product_key,tool_name_hint,occurrence_count`);
      console.log(`  最近 5 个候选样本:`);
      samples.forEach(s => console.log(`  · [${s.occurrence_count}] ${s.tool_name_hint || s.product_key}`));
    }
  }
})();
