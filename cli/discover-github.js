#!/usr/bin/env node
/**
 * 新锐发现 · GitHub 开源 AI 工具(官方 Search API,全新池子)
 *
 * 思路(全公开数据,官方接口):
 *   1) GitHub Search API 按若干 AI 主题(topic)查近期创建、高 star 的仓库(sort=stars)
 *   2) 只收「有 homepage(指向真官网域名)」的——那才是成品工具,域名干净;纯库/无主页的跳过
 *   3) 复用 screen(规则闸→AI 清洗中文化)→ 写 moxie_products(status=pending)
 * 与 PH/HN/聚合站/魔搭互补:这是「开源项目」这条线,很多新锐工具最早只在 GitHub 冒头。
 * 产出普通 pending 行,下游 enrich/promote/rank/prerender/gen-logos 照常,不改原格局。
 *
 * 跑法:node --env-file=.env.local cli/discover-github.js [--limit 20] [--min-stars 100] [--days 180] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY;可选 GITHUB_TOKEN(抬高速率)。
 */
import { screen } from './screen.mjs';
import { normDomain, uniqueSlug } from './lib.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Math.max(1, Number(arg('limit', '20')) || 20);
const MIN_STARS = Math.max(0, Number(arg('min-stars', '120')) || 0);
// 上限:近期新建却有几万星的基本是刷星 spam(真·爆款多半已在库或会从别的源进)。砍掉它们,只取"现实区间"的真新锐。
const MAX_STARS = Math.max(MIN_STARS + 1, Number(arg('max-stars', '6000')) || 6000);
const DAYS = Math.max(1, Number(arg('days', '180')) || 180);
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

// 查的 AI 主题(每个一条 Search 请求,sort=stars)。多主题去重,覆盖面广。
const TOPICS = ['ai-tools', 'llm', 'ai-agent', 'generative-ai', 'rag', 'text-to-image'];

// homepage 域名要跳过的:代码托管/包仓/社交/文档站(非"产品官网")
// homepage 为 *.github.io / *.gitlab.io 的:多是个人/论文/项目主页,不是产品官网(如 amshaker.github.io 点开是个人介绍)→ 一并跳过
const SKIP_HOST = /(^|\.)(github\.com|github\.io|gitlab\.com|gitlab\.io|gitee\.com|npmjs\.com|pypi\.org|crates\.io|readthedocs\.io|twitter\.com|x\.com|youtube\.com|youtu\.be|t\.me|discord\.gg|discord\.com|linkedin\.com|medium\.com|reddit\.com|t\.co|linktr\.ee|bit\.ly)$/i;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

async function ghSearch(topic, since) {
  const q = `topic:${topic} created:>${since} stars:${MIN_STARS}..${MAX_STARS}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=40`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'moxie-discover' };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return (await res.json()).items || [];
}

function hostOf(home) {
  if (!home) return null;
  let u = String(home).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

async function main() {
  console.log(`\n🐙 GitHub 开源 AI 工具发现${DRY_RUN ? ' [DRY-RUN]' : ''} · ★${MIN_STARS}~${MAX_STARS}(砍刷星) · 近${DAYS}天创建 · 上限 ${LIMIT}${GH_TOKEN ? ' · 已带token' : ''}\n`);
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

  const existing = await sb('/moxie_products?select=domain,slug,status&limit=4000');
  const known = new Set(existing.map((p) => normDomain(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => normDomain(p.domain)));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  // 多主题拉取 + 按 repo 去重 + 按 star 降序
  const repoMap = new Map();
  for (const t of TOPICS) {
    try {
      const items = await ghSearch(t, since);
      for (const r of items) if (!repoMap.has(r.id)) repoMap.set(r.id, r);
      console.log(`  topic:${t} → ${items.length} 个`);
    } catch (e) { console.log(`  ⚠ topic:${t} 失败(${e.message})`); }
  }
  const repos = [...repoMap.values()].sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
  console.log(`\n合并去重后 ${repos.length} 个仓库,逐个判定:\n`);

  const tally = { ok: 0, dup: 0, rejected: 0, nohome: 0, skiphost: 0, rule: 0, ai: 0, badcat: 0, fail: 0 };
  for (const r of repos) {
    if (tally.ok >= LIMIT) break;
    const domain = hostOf(r.homepage);
    if (!domain) { tally.nohome++; continue; }                 // 无主页 = 纯库,不收
    if (SKIP_HOST.test(domain)) { tally.skiphost++; continue; }
    if (rejected.has(domain)) { tally.rejected++; continue; }
    if (known.has(domain)) { tally.dup++; continue; }

    const name = (r.name || '').replace(/[-_]+/g, ' ').trim().slice(0, 60);
    const og = `${r.description || ''}${r.topics && r.topics.length ? '。标签:' + r.topics.slice(0, 6).join(',') : ''}`.slice(0, 400);
    if (!name) { tally.fail++; continue; }
    try {
      const r2 = await screen({ name, domain, og: og || name, occurrence_count: r.stargazers_count || 0, traffic_rank: null }, cats);
      if (r2.verdict !== 'keep') {
        console.log(`   ✗ ${name} (${domain}) ★${r.stargazers_count} → ${r2.stage === 'rule' ? '规则闸' : 'AI'}拒[${r2.kind}]`);
        r2.stage === 'rule' ? tally.rule++ : tally.ai++; continue;
      }
      const n = r2.normalized;
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
      if (DRY_RUN) { console.log(`   ✓[dry] ${name} (${domain}) ★${r.stargazers_count} [${n.category_slug}] ${n.tagline_zh}`); tally.ok++; continue; }
      known.add(domain); knownSlug.add(slug);
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
      console.log(`   ✓ ${name} (${domain}) ★${r.stargazers_count} [${n.category_slug}] → pending`);
      tally.ok++;
    } catch (err) {
      if (/duplicate key|23505|domain_unique/i.test(err.message)) tally.dup++;
      else { console.log(`   · ${name} → 失败(${err.message})`); tally.fail++; }
    }
  }

  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 黑名单 ${tally.rejected} · 无主页跳过 ${tally.nohome} · 非产品域名 ${tally.skiphost} · 规则拒 ${tally.rule} · AI拒 ${tally.ai} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 pending,等 enrich-detail 补 detail → promote 自动上架。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
