#!/usr/bin/env node
/**
 * 候选自动上架(T11)—— 直连 DB,无需 Next 后端
 *
 * discover-tools 把新工具写成 status=pending(已过 AI 清洗/中文化/闸门)。
 * 本脚本给 pending 打"完善度分",达阈值的自动 promote 成 published;不够的留着人工审。
 * 上架后由 refresh 流水线(rank→prerender→sitemap→IndexNow→同步)带上线。
 *
 * 跑法:node --env-file=.env.local cli/promote-candidates.js [--threshold N] [--limit N] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。阈值默认 70,每次最多 promote --limit(默认 8)。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const THRESHOLD = Number(arg('threshold', '70')) || 70;
const LIMIT = Number(arg('limit', '8')) || 8;
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }

async function sb(p, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${p}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

/** 完善度 0-100:有信息才给分,半成品自然不达标 */
function completeness(p) {
  let s = 0; const d = p.detail || {};
  if ((p.tagline || '').trim().length >= 10) s += 25;
  const tags = Array.isArray(p.tags) ? p.tags.length : 0;
  s += tags >= 2 ? 20 : tags === 1 ? 10 : 0;
  if (p.category_id) s += 15;
  if ((p.description || '').trim().length >= 20 || (Array.isArray(d.features) && d.features.length)) s += 20;
  if ((p.domain || '').trim()) s += 10;
  if ((p.price_label || '').trim()) s += 5;
  if ((p.domestic_available || '').toString().trim()) s += 5;
  return s;
}

async function main() {
  console.log(`\n🚀 候选自动上架(阈值 ${THRESHOLD},每次≤${LIMIT})${DRY_RUN ? ' [DRY-RUN]' : ''}\n`);
  const pend = await sb('/moxie_products?status=eq.pending&select=id,name,slug,domain,tagline,tags,description,price_label,domestic_available,category_id,detail&order=created_at.desc&limit=500');
  if (!pend.length) { console.log('无 pending 候选,跳过'); return; }

  // 反灰产末闸:复用发现层的 clean-gate.prefilter(只查域名:目录/聚合站 + 灰产 TLD,零误杀真工具)。
  // 保证"灰产域名永不被自动上架",不依赖上游发现一定干净——加源(如 T13)后仍守得住。
  const { prefilter } = await import('./clean-gate.mjs');
  const domainClean = (p) => !prefilter(p.name || '', p.domain || '').reject;

  // 上架硬条件:已 AI 清洗(有 detail.features)——保证 "published ⟺ 已清洗",杜绝 thin 工具上线
  const cleaned = (p) => !!(p.detail && Array.isArray(p.detail.features) && p.detail.features.length);
  const scored = pend.map((p) => ({ p, score: completeness(p), ready: cleaned(p), clean: domainClean(p) })).sort((a, b) => b.score - a.score);
  const pass = scored.filter((x) => x.ready && x.clean && x.score >= THRESHOLD).slice(0, LIMIT);
  const low = scored.filter((x) => x.score < THRESHOLD);
  const waitClean = scored.filter((x) => x.score >= THRESHOLD && x.clean && !x.ready);
  const grayBlocked = scored.filter((x) => x.ready && x.score >= THRESHOLD && !x.clean);
  console.log(`pending ${pend.length} · 达标且已清洗 ${scored.filter((x) => x.ready && x.clean && x.score >= THRESHOLD).length}(本次上架 ${pass.length})· 达标待清洗 ${waitClean.length}(等 enrich)· 不达标留审 ${low.length}\n`);
  if (waitClean.length) console.log(`待清洗(完善度够但无 detail,本轮不上架):` + waitClean.slice(0, 10).map((x) => x.p.name).join('、') + (waitClean.length > 10 ? ' …' : '') + '\n');
  if (grayBlocked.length) console.log(`⛔ 灰产末闸拦下(达标但域名是目录站/灰产 TLD,留 pending 不上架):` + grayBlocked.map((x) => `${x.p.name}(${x.p.domain})`).join('、') + '\n');

  let ok = 0;
  for (const { p, score } of pass) {
    console.log(`  ${DRY_RUN ? '[dry] ' : ''}↑ ${p.name}(${p.domain})完善度 ${score}`);
    if (!DRY_RUN) {
      try { await sb(`/moxie_products?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'published' } }); ok++; }
      catch (e) { console.log(`     失败:${e.message}`); }
    }
  }
  if (low.length) console.log(`\n留审(完善度<${THRESHOLD}):` + low.slice(0, 8).map((x) => `${x.p.name}(${x.score})`).join('、') + (low.length > 8 ? ' …' : ''));
  console.log(`\n汇总:上架 ${DRY_RUN ? pass.length + '(未写)' : ok} 款`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
