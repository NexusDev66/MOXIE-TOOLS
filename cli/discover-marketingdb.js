#!/usr/bin/env node
/**
 * 一手发现 · MarketingDB 上新(官方公开数据接口,厂商自助发布)
 *
 * marketingdb.live 前端直接查一个**公开的 Supabase REST**(anon key 公开在其页面源码里,非我方密钥):
 *   GET {ref}.supabase.co/rest/v1/community_projects?status=eq.approved&order=created_at.desc
 *   → 直接返回 project_name / project_url(真官网)/ tagline / category / logo_url / pricing。
 * 比爬它的 RSS/sitemap 强:真域名+标语+logo 一次给齐,不用再爬详情页。
 * 复用 screen(规则闸→AI 清洗中文化)→ 写 moxie_products(status=pending)。
 *
 * 注:那个 anon key 是 marketingdb 公开发布的(任何访客可见),非敏感。若它将来轮换导致本脚本失效,
 *     可临时把 cli/discover-sitemap.js 里 MarketingDB 的 disabled 去掉,退回 RSS(无需 key)。
 *
 * 跑法:node --env-file=.env.local cli/discover-marketingdb.js [--limit 20] [--fetch 120] [--dry-run]
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
const FETCH_N = Math.max(20, Number(arg('fetch', '120')) || 120);
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const LOGO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'logos');
// marketingdb 公开发布的 anon key(其页面源码可见,非我方密钥,只读 approved 项目)
const MDB_API = 'https://rdjsapsjjuteycsuwzxw.supabase.co/rest/v1/community_projects';
const MDB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkanNhcHNqanV0ZXljc3V3enh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MDY5MDcsImV4cCI6MjA4MzA4MjkwN30.Wv4NQHBqz6HIfj4oNgdbsHsH2vnjxUn8uNFADeUgUkk';

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

async function fetchProjects() {
  const q = `?select=project_name,project_url,tagline,logo_url,tags&status=eq.approved&order=created_at.desc&limit=${FETCH_N}`;
  const res = await fetch(MDB_API + q, { headers: { apikey: MDB_KEY, Authorization: `Bearer ${MDB_KEY}`, 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`MarketingDB ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`\n📈 MarketingDB 上新发现(官方接口)${DRY_RUN ? ' [DRY-RUN]' : ''} · 取最近 ${FETCH_N} · 上限 ${LIMIT}\n`);
  if (!DRY_RUN) mkdirSync(LOGO_DIR, { recursive: true });

  const existing = await sb('/moxie_products?select=domain,slug,status&limit=4000');
  const known = new Set(existing.map((p) => normDomain(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => normDomain(p.domain)));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  let items;
  try { items = await fetchProjects(); } catch (e) { console.log(`❌ 接口取不到(${e.message})。若是 anon key 轮换,临时退回 discover-sitemap 的 MarketingDB RSS。`); return; }
  console.log(`接口返回 ${items.length} 个,逐个判定:\n`);

  const tally = { ok: 0, dup: 0, rejected: 0, nodomain: 0, rule: 0, ai: 0, badcat: 0, fail: 0, logo: 0 };
  for (const t of items) {
    if (tally.ok >= LIMIT) break;
    const domain = hostOf(t.project_url);
    const name = (t.project_name || '').trim().slice(0, 60);
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
      if (await saveLogo(domain, t.logo_url)) tally.logo++;
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
