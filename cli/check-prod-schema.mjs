#!/usr/bin/env node
/**
 * 迁移前 schema 体检 —— 比对「沙盒(应有)」vs「生产(实有)」,列出生产库缺的表/列,并吐出补齐 SQL。
 *
 * 背景:重启版管道(cli + 静态站)在沙盒 `kyiqgvxvbxktiygohuqh` 上跑通。要迁到 latemai.com
 * 生产库 `sqvohgcwzhhsvkmyesvs` 前,必须先确认生产 schema 跟沙盒对齐,否则 cli 写库会 4xx
 * (已知生产历史上缺 detail/traffic_jsonb/weight_score 等列)。本脚本只读、不改任何库。
 *
 * 原理:PostgREST 根路径 `GET /rest/v1/` 暴露 OpenAPI,含每表每列+类型 → 解析对比。
 *
 * 跑法:
 *   node --env-file=.env.local cli/check-prod-schema.mjs
 * env:
 *   沙盒(应有,基线):NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  ← .env.local 已有
 *   生产(实有,待测):PROD_SUPABASE_URL + PROD_SERVICE_ROLE_KEY            ← 肖总给了再填
 * 没填 PROD_* 时:只打印沙盒基线(让你知道生产至少要有这些),不报错。
 */

const SANDBOX_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SANDBOX_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
const PROD_URL = (process.env.PROD_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const PROD_KEY = (process.env.PROD_SERVICE_ROLE_KEY || process.env.PROD_SUPABASE_SERVICE_ROLE_KEY || '').trim();

// 只关心这些表(站点 + 管道真正读写的);其余系统表忽略
const TABLES = ['moxie_products', 'moxie_categories', 'moxie_articles', 'moxie_news', 'moxie_voices', 'moxie_profiles', 'moxie_comments', 'moxie_votes'];

// OpenAPI format → PG 类型(用于生成 ALTER ADD COLUMN)
function pgType(prop) {
  if (!prop) return 'text';
  if (prop.type === 'array') return (prop.items && prop.items.format) ? `${prop.items.format}[]` : 'text[]';
  const f = (prop.format || '').toLowerCase();
  if (f) return f;                              // bigint / text / jsonb / boolean / uuid / timestamp with time zone ...
  return prop.type === 'integer' ? 'integer' : prop.type === 'boolean' ? 'boolean' : 'text';
}

async function introspect(url, key) {
  const r = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`${url} → ${r.status} ${(await r.text()).slice(0, 120)}`);
  const spec = await r.json();
  const defs = spec.definitions || (spec.components && spec.components.schemas) || {};
  const out = {};
  for (const t of TABLES) {
    if (!defs[t]) { out[t] = null; continue; }   // 表不存在
    const cols = {};
    for (const [c, prop] of Object.entries(defs[t].properties || {})) cols[c] = pgType(prop);
    out[t] = cols;
  }
  return out;
}

function printBaseline(expected) {
  console.log('\n沙盒基线(生产至少要有这些表/列):');
  for (const t of TABLES) {
    const cols = expected[t];
    console.log(`  ${t}${cols ? ` (${Object.keys(cols).length} 列)` : ' ❌沙盒里都没有?'}: ${cols ? Object.keys(cols).join(', ') : ''}`);
  }
}

async function main() {
  if (!SANDBOX_URL || !SANDBOX_KEY) { console.error('❌ 缺沙盒配置 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  console.log('🔍 迁移 schema 体检 — 沙盒(应有) vs 生产(实有)');

  const expected = await introspect(SANDBOX_URL, SANDBOX_KEY);

  if (!PROD_URL || !PROD_KEY) {
    console.log('\n⚠️  未设 PROD_SUPABASE_URL / PROD_SERVICE_ROLE_KEY —— 只打印沙盒基线,不做对比。');
    console.log('   肖总给了生产 service key 后,在 .env.local 里加:');
    console.log('     PROD_SUPABASE_URL=https://sqvohgcwzhhsvkmyesvs.supabase.co');
    console.log('     PROD_SERVICE_ROLE_KEY=sb_secret_...');
    console.log('   再跑本脚本,即可列出生产缺的表/列 + 补齐 SQL。');
    printBaseline(expected);
    return;
  }

  console.log(`\n生产库:${PROD_URL}`);
  const actual = await introspect(PROD_URL, PROD_KEY);

  const ddl = [];   // 补齐 SQL
  let gaps = 0;
  console.log('\n── 对比结果 ──');
  for (const t of TABLES) {
    const exp = expected[t];
    if (!exp) { console.log(`  · ${t}:沙盒里也没有,跳过`); continue; }
    const act = actual[t];
    if (act === null) {
      gaps++;
      console.log(`  ❌ ${t}:生产库【整张表缺失】(沙盒有 ${Object.keys(exp).length} 列)`);
      ddl.push(`-- ${t} 整张表缺失,需从沙盒 migration 建表(见 supabase/migrations/),此处仅列应有列:`);
      ddl.push(`--   ${Object.keys(exp).join(', ')}`);
      continue;
    }
    const missing = Object.keys(exp).filter((c) => !(c in act));
    if (!missing.length) { console.log(`  ✅ ${t}:列齐全(${Object.keys(exp).length})`); continue; }
    gaps += missing.length;
    console.log(`  ⚠️  ${t}:缺 ${missing.length} 列 → ${missing.join(', ')}`);
    for (const c of missing) ddl.push(`alter table public.${t} add column if not exists ${c} ${exp[c]};`);
  }

  if (ddl.length) {
    console.log('\n── 补齐 SQL(在生产库 SQL Editor 跑,跑前请人工核对类型/默认值)──');
    console.log(ddl.join('\n'));
  }

  console.log('\n── OpenAPI 看不到、需人工确认的(迁移 runbook 重点)──');
  console.log('  1. moxie_products.domain 是否有 UNIQUE 约束(upsert by domain 依赖它,缺了会插重复)');
  console.log('  2. moxie_products.status 取值/CHECK 是否含 pending/published/rejected/draft');
  console.log('  3. RLS 是否开启 + 策略(prod_read_public / prod_admin_write 等)');
  console.log('  4. 注册触发器 moxie_handle_new_user 是否已加 search_path(见 migrations/20260617120000_*)');
  console.log('  5. detail / traffic_jsonb 类型应为 jsonb;weight_score 为 numeric/double precision');

  console.log(`\n汇总:${gaps === 0 ? '✅ 生产 schema 与沙盒对齐,可迁移' : `⚠️ ${gaps} 处缺口,先跑上面的补齐 SQL 再迁移`}`);
}

main().catch((e) => { console.error('❌ 体检失败:', e.message); process.exit(1); });
