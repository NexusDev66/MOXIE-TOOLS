#!/usr/bin/env node
/**
 * 新锐工具发现 · Hacker News「Show HN」源(免凭据兜底)
 *
 * 用 HN Algolia 公开搜索 API(无需任何 token / 鉴权)拉近 N 天、点数达阈值的 Show HN 发布,
 * 标题含 AI 信号的才进:解析产品名 + 真实落地域名 → 复用 screen(规则闸→AI 清洗中文化)→ 写 pending。
 * 与 discover-tools(Product Hunt,需凭据)互补:PH 没配/拉不到时,这条仍能每天带新工具进来。
 *
 * 跑法:node --env-file=.env.local cli/discover-hn.js [--limit 30] [--days 7] [--min-points 15] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 */
import { screen } from './screen.mjs';
import { normDomain, uniqueSlug } from './lib.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const LIMIT = Math.max(1, Number(arg('limit', '30')) || 30);
const DAYS = Math.max(1, Number(arg('days', '7')) || 7);
const MIN_POINTS = Math.max(1, Number(arg('min-points', '10')) || 10);
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

// 标题/链接里有这些信号才认为可能是 AI 工具(省 DeepSeek 调用,非 AI 的 Show HN 直接跳过)
const AI_HINT = /\b(ai|a\.i\.|gpt|llm|llms|genai|agent|agents|agentic|chatbot|chat bot|copilot|assistant|prompt|prompts|rag|diffusion|generative|gen-?ai|neural|deep learning|machine learning|\bml\b|transformer|embedding|vector|fine-?tun|inference|multimodal|text-to-|speech-to-|image generation|stable diffusion|claude|gemini|mistral|ollama|whisper|sora)\b/i;
// 这些域名是平台/仓库/聚合,不是独立产品站,跳过
// 平台/仓库/聚合 + 托管 demo 页(github.io、*.pages.dev、streamlit 等):非独立产品站,跳过
const SKIP_HOST = /(^|\.)(github\.com|gitlab\.com|github\.io|gitlab\.io|news\.ycombinator\.com|reddit\.com|medium\.com|substack\.com|notion\.site|notion\.so|youtube\.com|youtu\.be|twitter\.com|x\.com|apps\.apple\.com|play\.google\.com|huggingface\.co|replit\.com|vercel\.app|netlify\.app|pages\.dev|web\.app|firebaseapp\.com|glitch\.me|streamlit\.app|surge\.sh|fly\.dev|onrender\.com|herokuapp\.com|ngrok\.io|ngrok-free\.app|gumroad\.com)$/i;

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
/** "Show HN: Granola – AI notepad…" → { name:"Granola", rest:"AI notepad…" } */
function parseTitle(title) {
  let t = String(title || '').replace(/^\s*show hn[:\-—]?\s*/i, '').trim();
  const parts = t.split(/\s*[–—:|]\s*|\s-\s/);
  const name = (parts[0] || t).trim().slice(0, 60);
  const rest = parts.slice(1).join(' ').trim();
  return { name, rest };
}

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

// ───── 发现:HN Algolia(Show HN,按点数过滤的近 N 天发布)─────
async function discoverHN() {
  const cutoff = Math.floor((Date.now() - DAYS * 86400000) / 1000);
  // search_by_date 才正确支持 created_at_i 时间过滤(search 是相关性排序,会忽略时间);numericFilters 需整体编码。
  const nf = encodeURIComponent(`created_at_i>${cutoff},points>=${MIN_POINTS}`);
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&numericFilters=${nf}&hitsPerPage=100`;
  const res = await fetch(url, { headers: { 'User-Agent': 'MoxieDiscoverBot/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HN API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.hits || [])
    .filter((h) => h.url && (h.title || ''))
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .map((h) => ({ title: h.title, url: h.url, points: h.points || 0, text: (h.story_text || '').replace(/<[^>]+>/g, ' ').slice(0, 400) }));
}

async function main() {
  console.log(`\n🟠 HN「Show HN」新锐发现${DRY_RUN ? ' [DRY-RUN]' : ''} · 近${DAYS}天 · 点数≥${MIN_POINTS} · 取前${LIMIT}\n`);

  const existing = await sb('/moxie_products?select=domain,slug,status&limit=2000');
  const known = new Set(existing.map((p) => normDomain(p.domain)));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const rejected = new Set(existing.filter((p) => p.status === 'rejected').map((p) => normDomain(p.domain)));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));

  const hits = (await discoverHN()).slice(0, LIMIT);
  console.log(`HN 候选 ${hits.length} 个(已按点数排序)\n`);

  const tally = { ok: 0, dup: 0, rejected: 0, notai: 0, skiphost: 0, rule: 0, ai: 0, badcat: 0, fail: 0 };
  for (const h of hits) {
    const host = hostOf(h.url);
    if (!host || SKIP_HOST.test(host)) { tally.skiphost++; continue; }
    // 标题/正文无 AI 信号 → 不是 AI 工具,省一次 DeepSeek
    if (!AI_HINT.test(`${h.title} ${h.text}`)) { tally.notai++; continue; }

    const domain = normDomain(host);
    if (rejected.has(domain)) { console.log(`  ⊘ ${h.title.slice(0, 40)} (${domain}) → 黑名单,跳过`); tally.rejected++; continue; }
    if (known.has(domain)) { tally.dup++; continue; }

    const { name, rest } = parseTitle(h.title);
    try {
      const og = [h.text, rest, h.title].filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
      const raw = { name, domain, og, occurrence_count: h.points, traffic_rank: null };
      const r = await screen(raw, cats);
      if (r.verdict !== 'keep') {
        console.log(`  ✗ ${name} (${domain}) → ${r.stage === 'rule' ? '规则闸' : 'AI'}拒[${r.kind}]:${r.reason}`);
        r.stage === 'rule' ? tally.rule++ : tally.ai++; continue;
      }
      const e = r.normalized;
      if (!e.category_slug || !catId[e.category_slug]) { console.log(`  · ${name} → 难归类,跳过`); tally.badcat++; continue; }
      if (!e.tagline_zh) { console.log(`  · ${name} → 归一缺卖点,跳过`); tally.fail++; continue; }

      const slug = uniqueSlug(name, domain, knownSlug);
      const row = {
        slug, name, domain,
        tagline: e.tagline_zh, description: e.description_zh,
        category_id: catId[e.category_slug], tags: e.tags,
        price_label: e.price_label, domestic_available: e.domestic_available,
        data_overseas: e.domestic_available !== '是', verified: false, featured: false,
        vote_count: 0, status: 'pending',
      };
      if (DRY_RUN) { console.log(`  ✓[dry] ${name} (${domain}) [${e.category_slug}] ${e.tagline_zh} | ${e.price_label}/${e.domestic_available} | HN ${h.points}分`); tally.ok++; continue; }
      known.add(domain); knownSlug.add(slug);
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
      console.log(`  ✓ ${name} (${domain}) [${e.category_slug}] · HN ${h.points}分 → pending`);
      tally.ok++;
    } catch (err) {
      if (/moxie_products_domain_unique|duplicate key|23505/i.test(err.message)) { tally.dup++; }
      else { console.log(`  · ${name} → 处理失败(${err.message}),跳过`); tally.fail++; }
    }
  }

  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 黑名单 ${tally.rejected} · 非AI跳过 ${tally.notai} · 平台域跳过 ${tally.skiphost} · 规则拒 ${tally.rule} · AI拒 ${tally.ai} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 status=pending,等 enrich-detail 补 detail → promote 自动上架。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
