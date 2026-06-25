#!/usr/bin/env node
/**
 * 一手发现 · trylaunch.ai 上新(官方公开接口,厂商自助发布)
 *
 * trylaunch.ai 是 "vibe coder"(Lovable/Cursor/Bolt/Replit/Claude Code 等建的产品)自助发布平台,AI 含量高。
 * 前端直接查公开 Supabase REST(anon key 公开在其页面源码,非我方密钥):
 *   GET {ref}.supabase.co/rest/v1/products?status=eq.launched&order=launch_date.desc
 *   → name / domain_url(真官网)/ tagline / launch_date / product_media[{url,type}](type=icon 即 logo)。
 * 复用 screen(规则闸→AI 清洗中文化)→ 写 moxie_products(status=pending);自带 icon 直接自托管。
 *
 * 注:anon key 是其公开发布的(任何访客可见),非敏感;若轮换导致失效,本步骤 continue-on-error 不阻塞。
 * 跑法:node --env-file=.env.local cli/discover-trylaunch.js [--limit 20] [--fetch 80] [--dry-run]
 */
import { screen } from './screen.mjs';
import { normDomain, uniqueSlug } from './lib.mjs';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Math.max(1, Number(arg('limit', '20')) || 20);
const FETCH_N = Math.max(20, Number(arg('fetch', '80')) || 80);
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const LOGO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'logos');
// trylaunch.ai 公开发布的 anon key(其页面源码可见,非我方密钥,只读 launched 产品)
const TL_API = 'https://gzpypxgdkxdynovploxn.supabase.co/rest/v1/products';
const TL_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd6cHlweGdka3hkeW5vdnBsb3huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM1NjUwMTUsImV4cCI6MjA3OTE0MTAxNX0.xG-0pm8FikCl-SL_nJORxHEmLSHY9KN77pEkOoEvZis';

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } }
function isImage(b) {
  if (!b || b.length < 16) return false;
  if (b[0] === 0x89 && b[1] === 0x50) return true;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return true;
  return false;
}
async function saveLogo(domain, logoUrl) {
  if (!logoUrl) return false;
  const out = join(LOGO_DIR, `${domain}.png`);
  if (existsSync(out)) return true;
  try {
    const res = await fetch(logoUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 70 && isImage(buf)) { writeFileSync(out, buf); return true; }
  } catch { /* gen-logos 兜底 */ }
  return false;
}

async function fetchProducts() {
  const q = `?select=name,tagline,slug,domain_url,launch_date,product_media(url,type)&status=eq.launched&order=launch_date.desc&limit=${FETCH_N}`;
  const res = await fetch(TL_API + q, { headers: { apikey: TL_KEY, Authorization: `Bearer ${TL_KEY}`, 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`trylaunch ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`\n🧑‍💻 trylaunch.ai 上新发现(官方接口·vibe coder 产品)${DRY_RUN ? ' [DRY-RUN]' : ''} · 取最近 ${FETCH_N} · 上限 ${LIMIT}\n`);
  if (!DRY_RUN) mkdirSync(LOGO_DIR, { recursive: true });

  const existing = await sb('/moxie_products?select=domain,slug,status&limit=4000');
  const known = new Set(existing.map((p) => normDomain(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => normDomain(p.domain)));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  let items;
  try { items = await fetchProducts(); } catch (e) { console.log(`❌ 接口取不到(${e.message})。若 anon key 轮换,本步骤跳过即可。`); return; }
  console.log(`接口返回 ${items.length} 个,逐个判定:\n`);

  const tally = { ok: 0, dup: 0, rejected: 0, nodomain: 0, rule: 0, ai: 0, badcat: 0, fail: 0, logo: 0 };
  for (const t of items) {
    if (tally.ok >= LIMIT) break;
    const domain = hostOf(t.domain_url);
    const name = (t.name || '').trim().slice(0, 60);
    if (!domain || !name) { tally.nodomain++; continue; }
    if (rejected.has(domain)) { tally.rejected++; continue; }
    if (known.has(domain)) { tally.dup++; continue; }
    try {
      const og = `${name}。${(t.tagline || '').replace(/\s+/g, ' ').trim()}`.slice(0, 400);
      const r = await screen({ name, domain, og, occurrence_count: 0, traffic_rank: null }, cats);
      if (r.verdict !== 'keep') {
        console.log(`   ✗ ${name} (${domain}) → ${r.stage === 'rule' ? '规则闸' : 'AI'}拒[${r.kind}]`);
        r.stage === 'rule' ? tally.rule++ : tally.ai++; continue;
      }
      const n = r.normalized;
      if (!n.category_slug || !catId[n.category_slug]) { tally.badcat++; continue; }
      if (!n.tagline_zh) { tally.fail++; continue; }
      const slug = uniqueSlug(name, domain, knownSlug);
      const row = {
        slug, name, domain,
        tagline: n.tagline_zh, description: n.description_zh,
        category_id: catId[n.category_slug], tags: n.tags,
        price_label: n.price_label, domestic_available: n.domestic_available,
        data_overseas: n.domestic_available !== '是', verified: false, featured: false,
        vote_count: 0, status: 'pending',
      };
      if (DRY_RUN) { console.log(`   ✓[dry] ${name} (${domain}) [${n.category_slug}] ${n.tagline_zh}`); tally.ok++; continue; }
      const icon = (t.product_media || []).find((m) => m.type === 'icon') || (t.product_media || [])[0];
      if (icon && await saveLogo(domain, icon.url)) tally.logo++;
      known.add(domain); knownSlug.add(slug);
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
      console.log(`   ✓ ${name} (${domain}) [${n.category_slug}] → pending`);
      tally.ok++;
    } catch (err) {
      if (/duplicate key|23505|domain_unique/i.test(err.message)) tally.dup++;
      else { console.log(`   · ${name} → 失败(${err.message})`); tally.fail++; }
    }
  }

  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 黑名单 ${tally.rejected} · 无名/无域名 ${tally.nodomain} · 规则拒 ${tally.rule} · AI拒 ${tally.ai} · 难归类 ${tally.badcat} · 失败 ${tally.fail} · 自带logo ${tally.logo}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 pending,等 enrich-detail 补 detail → promote 自动上架。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
