import { describe, it, expect } from 'vitest';
import { executePromote } from './promote-core';
import type { ProductPayload } from '@/lib/sync/validate';

/**
 * executePromote 单测 —— 重点验复审 #13 的 onExistingDomain='link':
 * domain 已存在时**不覆盖**人工维护的产品,只标候选 promoted + 链接现有产品。
 *
 * fake sb 按 表+操作 路由,并记录是否对 moxie_products 做了 insert/update(覆盖)。
 */

const payload: ProductPayload = { slug: 'cursor', name: 'Cursor', domain: 'cursor.com', tagline: 'AI IDE' };

function makeSb(opts: { existingProduct?: { id: number } | null; candidate?: { screenshot_url: string | null } }) {
  const calls = { productInsert: 0, productUpdate: 0, candidateUpdate: [] as Record<string, unknown>[] };
  const sb = {
    from(table: string) {
      const st: { op: 'select' | 'insert' | 'update'; patch: Record<string, unknown> | null } = { op: 'select', patch: null };
      const resolve = () => {
        if (table === 'moxie_products') {
          if (st.op === 'insert') {
            calls.productInsert++;
            return { data: { id: 9, slug: 'cursor' }, error: null };
          }
          if (st.op === 'update') {
            calls.productUpdate++;
            return { data: { id: 9, slug: 'cursor' }, error: null };
          }
          return { data: opts.existingProduct ?? null, error: null }; // select by domain
        }
        if (table === 'moxie_trend_candidates') {
          if (st.op === 'update') {
            calls.candidateUpdate.push(st.patch ?? {});
            return { data: null, error: null };
          }
          return { data: opts.candidate ?? { screenshot_url: null }, error: null };
        }
        return { data: null, error: null };
      };
      const qb = {
        select: () => qb,
        insert: (r: Record<string, unknown>) => { st.op = 'insert'; st.patch = r; return qb; },
        update: (p: Record<string, unknown>) => { st.op = 'update'; st.patch = p; return qb; },
        eq: () => qb,
        maybeSingle: () => Promise.resolve(resolve()),
        single: () => Promise.resolve(resolve()),
        then: (f: (r: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(f, r),
      };
      return qb;
    },
  } as never;
  return { sb, calls };
}

describe('executePromote · onExistingDomain', () => {
  it("link + 域已存在 → 不覆盖产品,仅链接候选到现有产品", async () => {
    const { sb, calls } = makeSb({ existingProduct: { id: 5 } });
    const res = await executePromote(sb, { candidateId: 1, payload, categoryMap: new Map(), onExistingDomain: 'link' });
    expect(res.ok).toBe(true);
    expect(res.linkedExisting).toBe(true);
    expect(res.productId).toBe(5);
    expect(res.inserted).toBe(false);
    // 关键:没有对产品做任何 insert / update(没覆盖人工类目/内容)
    expect(calls.productInsert).toBe(0);
    expect(calls.productUpdate).toBe(0);
    // 候选被标 promoted 且链接到现有产品 5
    expect(calls.candidateUpdate[0]!.status).toBe('promoted');
    expect(calls.candidateUpdate[0]!.promoted_product_id).toBe(5);
  });

  it('link + 域不存在 → 正常 INSERT 新建', async () => {
    const { sb, calls } = makeSb({ existingProduct: null });
    const res = await executePromote(sb, { candidateId: 1, payload, categoryMap: new Map(), onExistingDomain: 'link' });
    expect(res.ok).toBe(true);
    expect(res.inserted).toBe(true);
    expect(res.linkedExisting).toBeFalsy();
    expect(calls.productInsert).toBe(1);
    expect(calls.productUpdate).toBe(0);
  });
});
