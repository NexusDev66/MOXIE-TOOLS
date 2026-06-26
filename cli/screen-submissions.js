#!/usr/bin/env node
/**
 * 厂商自助提交 · 质量闸(latemai)
 * ------------------------------------------------------------------
 * 「提报我的产品」是浏览器直插库(RLS 只允许登录用户插 status='pending' + submitted_by=本人),
 * 这条路**绕过了发现管线的 screen(规则闸+AI判定)**——爬虫候选入库前都过了 keep/reject 判定,
 * 厂商手填的没过,只要 enrich 补了 features 就会被 promote 当"已清洗"自动上架,套壳/软文/非AI 会漏。
 *
 * 本脚本把厂商提交也过一遍同一道 screen:
 *   1. 抓官网首页做 grounding(抓不到就用厂商填的标语/简介,不阻塞)。
 *   2. screen(规则闸→AI 判定):
 *      · reject → status='rejected'(套壳/灰产/非AI/死站),并把理由记进 detail.screen_reason 供后台看。
 *      · keep   → 写回 AI 归一中文字段(与爬虫候选同口径)+ 盖 detail.submission_screened=true。
 * 之后 enrich-detail 补 features、promote 才放行(promote 对 submitted_by 行额外要求 submission_screened)。
 *
 * 跑法:node --env-file=.env.local cli/screen-submissions.js [--limit N] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */
import { screen } from './screen.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Number(arg('limit', '0')) || 0;
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

function pick(html, re) { const m = html.match(re); return m ? m[1].replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim() : ''; }
/** 抓官网首页 title + 描述,给 screen 做 grounding(抓不到返回 null,不阻塞) */
async function fetchSite(domain) {
  try {
    const res = await fetch(`https://${domain}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en;q=0.9,zh-CN;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 80000);
    const title = pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc = pick(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)
      || pick(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    if (!title && !desc) return null;
    return `${title} ${desc}`.trim().slice(0, 400);
  } catch { return null; }
}

async function main() {
  console.log(`\n🛂 厂商提交质量闸(screen 厂商手填的 pending)${DRY_RUN ? ' [DRY-RUN]' : ''}\n`);
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  // 厂商手填(submitted_by 非空)、待审(pending)、且尚未过闸(detail 无 submission_screened)
  let q = '/moxie_products?status=eq.pending&submitted_by=not.is.null&select=id,name,domain,tagline,description,category_id,detail,submitted_by&order=created_at.desc';
  if (LIMIT) q += `&limit=${LIMIT}`;
  const rows = (await sb(q)).filter((p) => !(p.detail && p.detail.submission_screened === true));
  if (!rows.length) { console.log('无待审的厂商提交,跳过'); return; }
  console.log(`待审 ${rows.length} 个:\n`);

  const tally = { keep: 0, reject: 0, fail: 0, grounded: 0 };
  for (const p of rows) {
    const name = (p.name || '').trim();
    const domain = (p.domain || '').trim();
    if (!name || !domain) { tally.fail++; continue; }
    try {
      const site = await fetchSite(domain);
      if (site) tally.grounded++;
      // grounding 优先用官网真实文案;抓不到退回厂商填的(仍受 AI 判定约束)
      const og = (site || `${p.tagline || ''}。${p.description || ''}`).slice(0, 400);
      const r = await screen({ name, domain, og, occurrence_count: 0, traffic_rank: null }, cats);

      if (r.verdict !== 'keep') {
        console.log(`  ✗ ${name}(${domain}) → ${r.stage === 'rule' ? '规则闸' : 'AI'}拒[${r.kind}]:${r.reason}`);
        tally.reject++;
        if (!DRY_RUN) await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'rejected', detail: { ...(p.detail || {}), submission_screened: true, screen_reason: `${r.kind}:${r.reason}`.slice(0, 160) } } });
        continue;
      }

      const n = r.normalized;
      const patch = { detail: { ...(p.detail || {}), submission_screened: true } };
      // keep:写回 AI 归一字段(与爬虫候选同口径),保证目录质量一致;name/domain 是身份事实不动
      if (n) {
        if (n.tagline_zh) patch.tagline = n.tagline_zh;
        if (n.description_zh) patch.description = n.description_zh;
        if (n.category_slug && catId[n.category_slug]) patch.category_id = catId[n.category_slug];
        if (Array.isArray(n.tags) && n.tags.length) patch.tags = n.tags;
        if (n.price_label) patch.price_label = n.price_label;
        if (n.domestic_available) { patch.domestic_available = n.domestic_available; patch.data_overseas = n.domestic_available !== '是'; }
      }
      console.log(`  ✓ ${name}(${domain}) → keep${n?.category_slug ? ` [${n.category_slug}]` : ''}${site ? ' [官网grounding]' : ''}`);
      tally.keep++;
      if (!DRY_RUN) await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
    } catch (e) { console.log(`  · ${name} → 失败(${e.message})`); tally.fail++; }
  }
  console.log(`\n汇总:通过 ${tally.keep} · 拒 ${tally.reject} · 失败 ${tally.fail} · 官网grounding ${tally.grounded}`);
  if (tally.keep && !DRY_RUN) console.log(`通过的等 enrich-detail 补 features → promote 才上架(promote 对厂商提交额外要 submission_screened)。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
