#!/usr/bin/env node
/**
 * 文章品牌封面生成(SVG)—— 不靠截图(国内被墙),用分类配色 + 标题 + 品牌设计
 *
 * 给每篇 published 文章生成一张 1200×630 的 SVG 封面,写到 public/covers/<slug>.svg,
 * 并把 moxie_articles.cover_url 设为 /public/covers/<slug>.svg。
 * 封面用于:博客列表卡(叠分类渐变)、文章详情 hero、Article JSON-LD image。
 *
 * 跑法:node --env-file=.env.local cli/gen-covers.js [--force] [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。默认只补缺(无 cover_url 的)。
 */

import fs from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const FORCE = process.argv.includes('--force');
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

// 分类 → 渐变配色(复用 moxie-blog.html 的分类色调)
const THEME = {
  横评: { a: '#1a1f36', b: '#2E3441', tag: '横向评测' },
  手册: { a: '#B5512E', b: '#DD6E4C', tag: '上手手册' },
  选型: { a: '#3a2e5f', b: '#5b4e8e', tag: '选型指南' },
  增长: { a: '#1f4937', b: '#2d6b50', tag: '增长打法' },
};
const DEFAULT_THEME = { a: '#1a1f36', b: '#2E3441', tag: '深度内容' };

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cw = (ch) => (/[\x00-\xff]/.test(ch) ? 0.55 : 1);
const tokW = (tk) => [...tk].reduce((s, c) => s + cw(c), 0);
/** 标题按字宽折行:英文单词/数字整体不拆,中文与标点可逐字断;每行预算 ~16.5,最多 3 行,超出加 … */
function wrap(title) {
  const per = 16.5, maxLines = 3;
  // token = 一个英文数字词 或 单个其它字符(中文/空格/标点)
  const tokens = title.match(/[A-Za-z0-9.+]+|[^A-Za-z0-9.+]/g) || [];
  const lines = []; let cur = '', w = 0; let overflow = false;
  for (const tk of tokens) {
    const tw = tokW(tk);
    if (w + tw > per && cur) {
      lines.push(cur); cur = ''; w = 0;
      if (lines.length === maxLines) { overflow = true; break; }
      if (tk === ' ') continue; // 行首空格丢弃
    }
    cur += tk; w += tw;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (overflow) lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, '…');
  return lines.map((l) => l.trimEnd());
}

function buildSvg(a) {
  const t = THEME[a.category] || DEFAULT_THEME;
  const lines = wrap(a.title);
  const fs0 = 60, lh = 80;
  const startY = 315 - ((lines.length - 1) * lh) / 2; // 垂直居中
  const titleTspans = lines.map((ln, i) => `<tspan x="80" y="${startY + i * lh}">${esc(ln)}</tspan>`).join('');
  const FONT = "'PingFang SC','Microsoft YaHei','Noto Sans SC','Hiragino Sans GB',sans-serif";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${FONT}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.a}"/><stop offset="1" stop-color="${t.b}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <text x="1180" y="600" text-anchor="end" font-size="220" font-weight="800" fill="#ffffff" opacity="0.05">#</text>
  <rect x="80" y="86" rx="20" ry="20" width="${tagWidth(t.tag)}" height="40" fill="#ffffff" opacity="0.16"/>
  <text x="${80 + 18}" y="113" font-size="20" font-weight="600" fill="#ffffff" letter-spacing="1">${esc(t.tag)}</text>
  <text font-size="${fs0}" font-weight="800" fill="#ffffff" letter-spacing="0.5">${titleTspans}</text>
  <rect x="80" y="540" width="44" height="6" rx="3" fill="#DD6E4C"/>
  <text x="80" y="582" font-size="30" font-weight="800" fill="#ffffff" letter-spacing="2">MOXIE</text>
  <text x="222" y="582" font-size="22" fill="#ffffff" opacity="0.7">子墨测评 · latemai.com</text>
  ${a.read_minutes ? `<text x="1120" y="582" text-anchor="end" font-size="22" fill="#ffffff" opacity="0.7">约 ${a.read_minutes} 分钟读</text>` : ''}
</svg>
`;
}
// 标签 pill 宽度:CJK*20 + ASCII*11 + 左右 padding 36
function tagWidth(s) { let w = 0; for (const c of s) w += /[\x00-\xff]/.test(c) ? 11 : 20; return Math.round(w + 36); }

async function main() {
  console.log(`\n🎨 文章封面生成(SVG)${DRY_RUN ? ' [DRY-RUN]' : ''}${FORCE ? ' [FORCE]' : ''}\n`);
  const arts = await sb('/moxie_articles?status=eq.published&select=id,slug,title,category,cover_url,read_minutes&order=published_at.desc&limit=1000');
  const dir = path.join(process.cwd(), 'public', 'covers');
  if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true });
  const todo = FORCE ? arts : arts.filter((a) => !a.cover_url);
  console.log(`共 ${arts.length} 篇,生成 ${todo.length} 张\n`);

  let ok = 0, fail = 0;
  for (const a of todo) {
    try {
      const svg = buildSvg(a);
      const rel = `/public/covers/${a.slug}.svg`;
      if (DRY_RUN) { console.log(`  ✓[dry] ${a.slug}.svg ← [${a.category}] ${a.title.slice(0, 24)}…`); ok++; continue; }
      fs.writeFileSync(path.join(dir, `${a.slug}.svg`), svg, 'utf8');
      await sb(`/moxie_articles?id=eq.${a.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { cover_url: rel } });
      console.log(`  ✓ ${a.slug}.svg`);
      ok++;
    } catch (e) { console.log(`  · ${a.slug} → 失败(${e.message})`); fail++; }
  }
  console.log(`\n汇总:封面 ${ok} · 失败 ${fail}${DRY_RUN ? '(未写)' : ''}`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
