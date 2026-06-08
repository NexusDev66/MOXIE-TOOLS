#!/usr/bin/env node
/**
 * Phase 0 · 头部种子工具入库（latemai 数据闭环）
 *
 * 读 cli/seed-tools.json → 解析 category_slug → upsert 到 moxie_products(status=published)。
 * 让静态站当天就有真内容可看。幂等(按 slug merge),可重复跑。
 *
 * 跑法:
 *   node --env-file=.env.local cli/seed-products.js [--dry-run]
 * 需要 env: SUPABASE_SERVICE_ROLE_KEY(或 SUPABASE_SERVICE_KEY)
 *
 * 注:vote_count 这里给的是「临时排序值」(featured>verified>普通),
 *     真正的排序在 Phase 2 由 weight_score 权重算法接管。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL) {
  console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL(在 .env.local 里)');
  process.exit(1);
}
const DRY_RUN = process.argv.includes('--dry-run');

if (!SERVICE_KEY) {
  console.error('❌ 缺 SUPABASE_SERVICE_ROLE_KEY —— 在 .env.local 填上 service_role 密钥,然后用:');
  console.error('   node --env-file=.env.local cli/seed-products.js');
  process.exit(1);
}

const __dir = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(__dir, 'seed-tools.json'), 'utf8'));

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** 临时排序值(Phase 2 weight_score 会接管) */
function provisionalVotes(t) {
  if (t.featured) return 280;
  if (t.verified) return 120;
  return 40;
}

async function main() {
  console.log(`\n🌱 Phase 0 种子入库${DRY_RUN ? ' [DRY-RUN]' : ''} · ${seed.length} 个工具\n`);

  // 1. 分类 slug → id
  const cats = await sb('/moxie_categories?select=id,slug');
  const catId = new Map(cats.map((c) => [c.slug, c.id]));
  console.log(`   分类映射: ${cats.length} 个`);

  // 2. 组装行(校验 category_slug 存在)
  const rows = [];
  const skipped = [];
  for (const t of seed) {
    const category_id = catId.get(t.category_slug);
    if (!category_id) {
      skipped.push(`${t.slug}(未知分类 ${t.category_slug})`);
      continue;
    }
    rows.push({
      slug: t.slug,
      name: t.name,
      domain: t.domain,
      tagline: t.tagline,
      category_id,
      tags: t.tags ?? [],
      price_label: t.price_label ?? '不详',
      domestic_available: t.domestic_available ?? 'partial',
      verified: !!t.verified,
      featured: !!t.featured,
      vote_count: provisionalVotes(t),
      status: 'published',
    });
  }
  if (skipped.length) console.log(`   ⚠ 跳过 ${skipped.length}: ${skipped.join(', ')}`);

  if (DRY_RUN) {
    console.log(`\n   [dry] 将 upsert ${rows.length} 行(按 slug 幂等),status=published`);
    console.log(`   示例:`, JSON.stringify(rows[0], null, 2));
    return;
  }

  // 3. upsert(按 slug 幂等;只覆盖事实字段,vote_count 临时值)
  const result = await sb('/moxie_products?on_conflict=slug', {
    method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates',
    body: rows,
  });
  console.log(`\n✓ upsert 完成:${result.length} 行 published`);

  // 4. 复核:线上 published 产品总数
  const all = await sb('/moxie_products?status=eq.published&select=id');
  console.log(`✓ 现在库里 published 产品总数:${all.length}`);
  console.log(`\n下一步:打开静态站(或本地起站)应能看到这些工具。\n`);
}

main().catch((e) => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});
