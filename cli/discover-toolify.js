#!/usr/bin/env node
/**
 * Toolify 发现(Playwright 真浏览器过 Cloudflare)——独立任务,不进 6 小时主循环
 *
 * Toolify 用 Cloudflare JS 挑战,普通 fetch(数据中心 IP)被 403。本脚本用真浏览器:
 *   ① 打开首页过挑战(拿 cf_clearance)→ ② 同源 fetch sitemap_tools 取最新工具 URL
 *   → ③ 逐页渲染提取 名字/简介/真实官网域名 → ④ 复用 screen 清洗中文化 → 写 pending
 * 关键未知数:GitHub Actions 是数据中心 IP,Cloudflare 可能照挡 —— 本脚本会**明确打印过没过**。
 *
 * 跑法(需先 npm i playwright + npx playwright install chromium):
 *   node --env-file=.env.local cli/discover-toolify.js [--limit 30] [--dry-run]
 */
import { chromium } from 'playwright';
import { screen } from './screen.mjs';
import { normDomain, uniqueSlug } from './lib.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Math.max(1, Number(arg('limit', '30')) || 30);
const DRY_RUN = process.argv.includes('--dry-run');
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const AI_HINT = /\b(ai|gpt|llm|agent|agentic|generative|gen-?ai|diffusion|chatbot|copilot|assistant|prompt|neural|machine learning|multimodal|text-to-|image|video|voice|speech|transcrib|deepfake|avatar)\b|智能|生成|大模型|语言模型/i;
const SKIP_HOST = /(^|\.)(toolify\.ai|twitter\.com|x\.com|facebook\.com|linkedin\.com|youtube\.com|youtu\.be|instagram\.com|tiktok\.com|t\.me|discord\.gg|discord\.com|apps\.apple\.com|play\.google\.com|github\.com|pxf\.io|sjv\.io|bit\.ly)$/i;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

async function main() {
  console.log(`\n🛡  Toolify(Playwright 过 Cloudflare)${DRY_RUN ? ' [DRY-RUN]' : ''} · 取最新 ${LIMIT}\n`);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1366, height: 850 } });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await ctx.newPage();

  // ① 过 Cloudflare
  try { await page.goto('https://www.toolify.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { console.log('  打开首页超时:', e.message); }
  let title = '';
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(5000);
    title = await page.title().catch(() => '');
    if (/toolify/i.test(title) && !/just a moment|attention required|moment\.\.\./i.test(title)) break;
  }
  const passed = /toolify/i.test(title) && !/just a moment|attention required/i.test(title);
  console.log(`  ▸ Cloudflare:${passed ? '✓ 过了' : '✗ 被挡'}(title="${title}")`);
  if (!passed) {
    console.log('  ✗ 结论:GitHub Actions 数据中心 IP 没过 Toolify 的 Cloudflare → 该走方案①(本地定时)或②(付费抓取API)');
    await browser.close(); return;
  }

  // ② 同源取 sitemap → 最新工具 URL
  const toolUrls = await page.evaluate(async () => {
    const idx = await (await fetch('/sitemap.xml')).text();
    const subs = [...idx.matchAll(/<loc>([^<]+sitemap_tools[^<]+\.xml)<\/loc>/gi)].map((m) => m[1]).slice(0, 4);
    let items = [];
    for (const s of subs) {
      try {
        const xml = await (await fetch(s)).text();
        for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
          const loc = (m[1].match(/<loc>([^<]+)<\/loc>/i) || [])[1] || '';
          const lm = (m[1].match(/<lastmod>([^<]+)<\/lastmod>/i) || [])[1] || '';
          if (/\/tool\/[^/]+$/.test(loc) && !/\/(zh|tw|ko|de|es|fr|ja|pt|it|hi|id|ru)\/tool\//.test(loc)) items.push({ loc, lm });
        }
      } catch {}
    }
    items.sort((a, b) => (b.lm || '').localeCompare(a.lm || ''));
    return items.slice(0, 200).map((i) => i.loc);
  });
  console.log(`  ▸ 拿到工具页 ${toolUrls.length} 个,取最新 ${Math.min(LIMIT, toolUrls.length)}\n`);

  // 去重准备
  const existing = await sb('/moxie_products?select=domain,slug,status&limit=3000');
  const known = new Set(existing.map((p) => normDomain(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => normDomain(p.domain)));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  const tally = { ok: 0, dup: 0, rejected: 0, notai: 0, nodomain: 0, rule: 0, ai: 0, badcat: 0, fail: 0 };
  for (const url of toolUrls.slice(0, LIMIT)) {
    let d;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      d = await page.evaluate(() => {
        const meta = (p) => (document.querySelector(`meta[property="${p}"],meta[name="${p}"]`) || {}).content || '';
        let site = '';
        for (const a of document.querySelectorAll('a[href^="http"]')) {
          const t = (a.textContent || '').toLowerCase(); const h = a.href;
          if (/toolify\.ai/.test(h)) continue;
          if (/visit|website|官网|open site|go to site|visit site/.test(t)) { site = h; break; }
        }
        return { name: ((document.querySelector('h1') || {}).textContent || '').trim(), desc: meta('og:description') || meta('description'), site };
      });
    } catch { tally.fail++; continue; }
    const name = String(d.name || '').slice(0, 60).trim();
    const og = String(d.desc || '').slice(0, 400);
    if (!name) { tally.fail++; continue; }
    if (!AI_HINT.test(`${name} ${og}`)) { tally.notai++; continue; }
    let domain = null;
    try { const h = new URL(d.site).hostname.replace(/^www\./, '').toLowerCase(); if (h && !SKIP_HOST.test(h)) domain = h; } catch {}
    if (!domain) { tally.nodomain++; continue; }
    if (rejected.has(domain)) { tally.rejected++; continue; }
    if (known.has(domain)) { tally.dup++; continue; }
    try {
      const r = await screen({ name, domain, og: og || name, occurrence_count: 0, traffic_rank: null }, cats);
      if (r.verdict !== 'keep') { console.log(`   ✗ ${name} (${domain}) → ${r.stage === 'rule' ? '规则' : 'AI'}拒[${r.kind}]`); r.stage === 'rule' ? tally.rule++ : tally.ai++; continue; }
      const n = r.normalized;
      if (!n.category_slug || !catId[n.category_slug]) { tally.badcat++; continue; }
      if (!n.tagline_zh) { tally.fail++; continue; }
      const slug = uniqueSlug(name, domain, knownSlug);
      const row = { slug, name, domain, tagline: n.tagline_zh, description: n.description_zh, category_id: catId[n.category_slug], tags: n.tags, price_label: n.price_label, domestic_available: n.domestic_available, data_overseas: n.domestic_available !== '是', verified: false, featured: false, vote_count: 0, status: 'pending' };
      if (DRY_RUN) { console.log(`   ✓[dry] ${name} (${domain}) [${n.category_slug}] ${n.tagline_zh}`); tally.ok++; continue; }
      known.add(domain); knownSlug.add(slug);
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
      console.log(`   ✓ ${name} (${domain}) [${n.category_slug}] → pending`);
      tally.ok++;
    } catch (e) { console.log(`   · ${name} → 失败(${e.message})`); tally.fail++; }
  }
  await browser.close();
  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 黑名单 ${tally.rejected} · 非AI跳过 ${tally.notai} · 无域名 ${tally.nodomain} · 规则拒 ${tally.rule} · AI拒 ${tally.ai} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
