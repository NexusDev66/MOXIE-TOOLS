import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProductPayload } from './validate.js';

/**
 * 把入库 payload 写到 moxie_products，按 domain 幂等。
 *
 * ⚠️ 关键语义（邓晖 P1 review 后修正）：
 *   INSERT 和 UPDATE 写**不同的字段集**，绝不能用单个全量 upsert：
 *
 *   - 新 domain → INSERT 全量行：事实字段 + sync 默认值（status='pending' 等）
 *   - 同 domain → UPDATE **只更事实字段**（scanner 每次都能提供的）：
 *       slug / name / tagline / description / tags / category_id / updated_at
 *     **绝不触碰人工 / 运行时字段**：
 *       status / domestic_available / price_label / data_overseas /
 *       vote_count / verified / featured
 *     —— 否则 admin publish + 人工填好的产品会被 re-sync 打回 pending、人工字段丢失
 *
 * 返回 inserted 标识让 caller 决定 HTTP 201 (新建) 还是 200 (更新)。
 *
 * 不在这里做的事:
 *   - 校验 category_slug 存在性 —— 由 caller 在调用前查 moxie_categories
 *   - 写 audit_log —— 由 caller 包一层
 */

export interface UpsertResult {
  id: number;
  slug: string;
  inserted: boolean;       // true = 新建; false = 更新已存在的 domain
}

export interface UpsertOptions {
  /** category_slug → category_id 映射（caller 预先查好） */
  categoryIdBySlug: Map<string, number>;
}

/** Postgres unique_violation */
const PG_UNIQUE_VIOLATION = '23505';

export async function upsertProductByDomain(
  sb: SupabaseClient,
  payload: ProductPayload,
  opts: UpsertOptions,
): Promise<UpsertResult> {
  const categoryId = payload.category_slug
    ? opts.categoryIdBySlug.get(payload.category_slug) ?? null
    : null;

  // 事实字段：scanner / sync 每次都能从抓取/AI 得到，UPDATE 时刷新
  const factualFields = {
    slug: payload.slug,
    name: payload.name,
    tagline: payload.tagline,
    description: payload.description ?? null,
    category_id: categoryId,
    tags: payload.tags ?? [],
    updated_at: new Date().toISOString(),
  };

  // 1. 查 domain 是否已存在
  const { data: existing, error: selErr } = await sb
    .from('moxie_products')
    .select('id')
    .eq('domain', payload.domain)
    .maybeSingle();
  if (selErr) {
    throw new Error(`select-by-domain failed: ${selErr.message}`);
  }

  // 2a. 已存在 → UPDATE 只更事实字段，保留人工/运行时字段
  if (existing) {
    return await updateFactual(sb, existing.id as number, factualFields);
  }

  // 2b. 新 domain → INSERT 全量行（含 sync 默认值）
  //     price_label 默认 '不详'：sync 来的数据不能假设免费，比 DB 列默认 '免费' 更诚实
  //     （moxie_products.price_label 的 DB 默认 '免费' 只服务于手动提交表单流程）
  const insertRow = {
    ...factualFields,
    domain: payload.domain,
    price_label: payload.price_label ?? '不详',
    domestic_available: payload.domestic_available ?? 'partial',
    data_overseas: payload.data_overseas ?? false,
    status: 'pending',
  };
  const { data, error } = await sb
    .from('moxie_products')
    .insert(insertRow)
    .select('id, slug')
    .single();

  if (error) {
    // TOCTOU: 两个并发请求同新 domain 都通过了上面的 select，
    // 其中一个 INSERT 撞 domain unique 约束 → 回落到 UPDATE 路径
    if (error.code === PG_UNIQUE_VIOLATION) {
      const { data: raced } = await sb
        .from('moxie_products')
        .select('id')
        .eq('domain', payload.domain)
        .maybeSingle();
      if (raced) {
        return await updateFactual(sb, raced.id as number, factualFields);
      }
    }
    throw new Error(`insert failed: ${error.message}`);
  }
  if (!data) throw new Error('insert returned no data');

  return {
    id: data.id as number,
    slug: data.slug as string,
    inserted: true,
  };
}

/** UPDATE 已存在产品的事实字段，返回 inserted:false */
async function updateFactual(
  sb: SupabaseClient,
  id: number,
  factualFields: Record<string, unknown>,
): Promise<UpsertResult> {
  const { data, error } = await sb
    .from('moxie_products')
    .update(factualFields)
    .eq('id', id)
    .select('id, slug')
    .single();
  if (error || !data) {
    throw new Error(`update failed: ${error?.message ?? 'unknown'}`);
  }
  return {
    id: data.id as number,
    slug: data.slug as string,
    inserted: false,
  };
}

/**
 * 拉 moxie_categories slug → id 映射。一次 request 缓存一次。
 * caller 持有 map 实例，传给 upsertProductByDomain。
 */
export async function loadCategoryMap(
  sb: SupabaseClient,
): Promise<Map<string, number>> {
  const { data, error } = await sb
    .from('moxie_categories')
    .select('id, slug');
  if (error) {
    throw new Error(`load categories failed: ${error.message}`);
  }
  const map = new Map<string, number>();
  for (const row of data ?? []) {
    map.set(row.slug as string, row.id as number);
  }
  return map;
}
