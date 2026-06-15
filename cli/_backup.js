#!/usr/bin/env node
/**
 * 库表备份 —— 动手改生产库前先导出关键表为 JSON(可回滚依据)
 *
 * 跑法:node --env-file=.env.prod cli/_backup.js [--out backups]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY(读全表,绕 RLS)。
 * 输出:backups/<table>-<时间戳>.json,每表一份。表不存在则跳过。
 */

import fs from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const OUT = arg('out', 'backups');

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 SUPABASE 配置(用 .env.prod)'); process.exit(1); }

const TABLES = ['moxie_products', 'moxie_categories', 'moxie_articles', 'moxie_news', 'moxie_voices', 'moxie_trend_candidates'];
const PAGE = 1000;

async function dumpTable(t) {
  let offset = 0, all = [];
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*&limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!res.ok) { if (res.status === 404) return null; throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`); }
    const rows = await res.json();
    all = all.concat(rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(process.cwd(), OUT);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n💾 备份生产库 → ${OUT}/  (${stamp})\n`);
  for (const t of TABLES) {
    try {
      const rows = await dumpTable(t);
      if (rows === null) { console.log(`  · ${t} 不存在,跳过`); continue; }
      const f = path.join(dir, `${t}-${stamp}.json`);
      fs.writeFileSync(f, JSON.stringify(rows, null, 0), 'utf8');
      console.log(`  ✓ ${t}: ${rows.length} 行 → ${path.basename(f)}`);
    } catch (e) { console.log(`  ✗ ${t} 失败:${e.message}`); }
  }
  console.log(`\n完成。回滚时可据此 JSON 还原。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
