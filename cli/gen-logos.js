#!/usr/bin/env node
/**
 * 工具 logo 自托管补全(大陆访问 + 新品图标)
 *
 * 新发现的工具没有本地 logo → 前端 moxieLogoFallback 显示首字母占位。
 * 本脚本在构建时(GitHub Actions·美网)抓每个缺图工具自己官网的图标
 * (apple-touch-icon / link icon / favicon.ico),存成同源 public/logos/<domain>.png。
 * 同源 + 构建时抓取 = 不踩 GFW、不依赖 Google favicon。已存在的不重抓。
 *
 * 跑法:node --env-file=.env.local cli/gen-logos.js [--force] [--limit N]
 * 读 published 用 anon key。
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const FORCE = process.argv.includes('--force');
const LIMIT = Number((process.argv[process.argv.indexOf('--limit') + 1]) || 0) || 0;
if (!SUPABASE_URL || !ANON) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY'); process.exit(1); }

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '..', 'public', 'logos');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 图片魔数:PNG / JPEG / ICO / GIF / WEBP(BMP 也收)。拒绝 SVG/HTML(用 .png 名伺服不渲染)。
function isImage(buf) {
  if (buf.length < 16) return false;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;       // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                          // JPEG
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) return true; // ICO/CUR
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                          // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return true;   // WEBP(RIFF..WE)
  if (b[0] === 0x42 && b[1] === 0x4d) return true;                                            // BMP
  return false;
}

async function fetchBuf(url, t = 12000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(t) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** 从官网 HTML 选最佳图标 URL:apple-touch-icon > rel icon(png) > 其它 rel icon */
function pickIcon(html, base) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const parse = (tag) => {
    const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1] || '';
    const sizes = (tag.match(/sizes=["']([^"']+)["']/i) || [])[1] || '';
    return { rel: rel.toLowerCase(), href, sizes };
  };
  const cands = links.map(parse).filter((l) => /icon/.test(l.rel) && l.href && !/\.svg(\?|$)/i.test(l.href));
  const score = (l) => {
    let s = 0;
    if (/apple-touch-icon/.test(l.rel)) s += 100;
    if (/\.png(\?|$)/i.test(l.href)) s += 30;
    const sz = parseInt((l.sizes.match(/(\d+)/) || [])[1] || '0', 10);
    s += Math.min(sz, 256) / 10;
    return s;
  };
  cands.sort((a, b) => score(b) - score(a));
  if (cands[0]) { try { return new URL(cands[0].href, base).href; } catch { return null; } }
  return null;
}

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

async function getLogo(domain) {
  // ① 官网 HTML 里挑 apple-touch-icon / link icon ② 退而求 /favicon.ico ③ 顶级域 /favicon.ico
  const tries = [];
  try {
    const html = (await (await fetch(`https://${domain}/`, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) })).text()).slice(0, 80000);
    const icon = pickIcon(html, `https://${domain}/`);
    if (icon) tries.push(icon);
  } catch {}
  tries.push(`https://${domain}/apple-touch-icon.png`, `https://${domain}/favicon.ico`);
  // 兜底图标服务(聚合 Google/Clearbit/DDG/favicon;构建时抓 + 自托管 → 大陆安全)。最大化命中率。
  tries.push(
    `https://unavatar.io/${domain}?fallback=false`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
  );
  for (const u of tries) {
    try { const buf = await fetchBuf(u); if (buf.length > 70 && isImage(buf)) return buf; } catch {}
  }
  return null;
}

async function main() {
  console.log(`\n🎨 工具 logo 补全${FORCE ? ' [FORCE]' : ''}\n`);
  mkdirSync(OUT, { recursive: true });
  const prods = await sb('moxie_products?status=eq.published&select=name,domain&order=created_at.desc&limit=2000');
  let todo = prods.filter((p) => p.domain && (FORCE || !existsSync(join(OUT, `${p.domain}.png`))));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`published ${prods.length},缺 logo ${todo.length}${LIMIT ? `(本次 ${todo.length})` : ''}\n`);

  let ok = 0, fail = 0;
  for (const p of todo) {
    try {
      const buf = await getLogo(p.domain);
      if (buf) { writeFileSync(join(OUT, `${p.domain}.png`), buf); console.log(`  ✓ ${p.name}(${p.domain})${Math.round(buf.length / 1024)}KB`); ok++; }
      else { console.log(`  · ${p.name}(${p.domain})→ 没拿到,留首字母兜底`); fail++; }
    } catch (e) { console.log(`  · ${p.domain} → 失败(${e.message})`); fail++; }
  }
  console.log(`\n汇总:补 logo ${ok} · 没拿到 ${fail}(兜底首字母)`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
