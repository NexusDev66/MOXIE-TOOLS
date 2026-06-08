import { describe, it, expect } from 'vitest';
import {
  enqueueCategoryRoundup,
  enqueueWeeklyTrend,
  isoWeekKey,
  startOfISOWeek,
  ROUNDUP_THRESHOLD,
} from './article-enqueue';

/**
 * T10 enqueue 触发逻辑单测。
 * 用一个链式 fake Supabase client:products 的 SELECT 返回预置行,
 * jobs 的 INSERT 记录入参并返回预置结果(可模拟 unique 冲突)。
 */

interface Result {
  data: unknown;
  error: unknown;
}

function makeSb(opts: { products?: { id: number }[]; insert?: Result }) {
  const inserted: Array<Record<string, unknown>> = [];
  const sb = {
    from(table: string) {
      const state: { op: 'select' | 'insert' | 'update'; payload: Record<string, unknown> | null } = {
        op: 'select',
        payload: null,
      };
      const resolve = (): Result => {
        if (table === 'moxie_products') return { data: opts.products ?? [], error: null };
        if (table === 'moxie_article_jobs') {
          if (state.op === 'insert') {
            inserted.push(state.payload ?? {});
            return opts.insert ?? { data: { id: 1 }, error: null };
          }
          return { data: [], error: null };
        }
        return { data: null, error: null };
      };
      const qb = {
        select: () => qb,
        insert: (row: Record<string, unknown>) => {
          state.op = 'insert';
          state.payload = row;
          return qb;
        },
        eq: () => qb,
        in: () => qb,
        gte: () => qb,
        lte: () => qb,
        or: () => qb,
        order: () => qb,
        limit: () => qb,
        single: () => Promise.resolve(resolve()),
        maybeSingle: () => Promise.resolve(resolve()),
        then: (f: (r: Result) => unknown, r?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(f, r),
      };
      return qb;
    },
  };
  return { sb: sb as never, inserted };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

describe('ISO 周辅助', () => {
  it('startOfISOWeek 取到周一 00:00 UTC', () => {
    // 2026-06-05 是周五 → 本周一是 2026-06-01
    const monday = startOfISOWeek(new Date('2026-06-05T10:00:00Z'));
    expect(monday.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
  it('isoWeekKey 同一周稳定、跨周变化', () => {
    const k1 = isoWeekKey(new Date('2026-06-01T00:00:00Z')); // 周一
    const k2 = isoWeekKey(new Date('2026-06-07T23:00:00Z')); // 同周周日
    const k3 = isoWeekKey(new Date('2026-06-08T00:00:00Z')); // 下周一
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('isoWeekKey 跨年边界(ISO 周年规则)', () => {
    // 2026 以周四开年 → 53 周;2026-12-31(周四)= W53
    expect(isoWeekKey(new Date('2026-12-31T00:00:00Z'))).toBe('2026-W53');
    // 2027-01-01(周五)归上一年最后一周 2026-W53
    expect(isoWeekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    // 2025-01-01(周三)归 2025-W01
    expect(isoWeekKey(new Date('2025-01-01T00:00:00Z'))).toBe('2025-W01');
  });
});

describe('enqueueCategoryRoundup（事件驱动）', () => {
  it('未达阈值 → 不入队', async () => {
    const { sb, inserted } = makeSb({ products: rows(ROUNDUP_THRESHOLD - 1) });
    const r = await enqueueCategoryRoundup(sb, { categoryId: 7, categorySlug: 'ai-coding' });
    expect(r.enqueued).toBe(false);
    expect(r.reason).toContain('未达阈值');
    expect(inserted).toHaveLength(0);
  });

  it('达阈值 → 入队 compare,payload + dedupe_key 正确', async () => {
    const { sb, inserted } = makeSb({ products: rows(ROUNDUP_THRESHOLD), insert: { data: { id: 42 }, error: null } });
    const r = await enqueueCategoryRoundup(sb, {
      categoryId: 7,
      categorySlug: 'ai-coding',
      now: new Date('2026-06-05T10:00:00Z'),
    });
    expect(r.enqueued).toBe(true);
    expect(r.jobId).toBe(42);
    expect(inserted).toHaveLength(1);
    const job = inserted[0]!;
    expect(job.job_type).toBe('category_roundup');
    expect(job.status).toBe('pending');
    expect(job.dedupe_key).toBe(`roundup:ai-coding:${isoWeekKey(new Date('2026-06-05T10:00:00Z'))}`);
    const payload = job.payload as { template: string; product_ids: number[] };
    expect(payload.template).toBe('compare');
    expect(payload.product_ids).toHaveLength(ROUNDUP_THRESHOLD);
  });

  it('dedupe_key 撞 unique(23505) → 视为本周已入队', async () => {
    const { sb } = makeSb({ products: rows(ROUNDUP_THRESHOLD), insert: { data: null, error: { code: '23505' } } });
    const r = await enqueueCategoryRoundup(sb, { categoryId: 7, categorySlug: 'ai-coding' });
    expect(r.enqueued).toBe(false);
    expect(r.reason).toContain('已入队');
  });
});

describe('enqueueWeeklyTrend（定时）', () => {
  it('本周有 high-value 产品 → 入队 pick 趋势文', async () => {
    const { sb, inserted } = makeSb({ products: rows(2), insert: { data: { id: 9 }, error: null } });
    const r = await enqueueWeeklyTrend(sb, { now: new Date('2026-06-05T10:00:00Z') });
    expect(r.enqueued).toBe(true);
    const job = inserted[0]!;
    expect(job.job_type).toBe('weekly_trend');
    expect((job.payload as { template: string }).template).toBe('pick');
    expect(job.dedupe_key).toBe(`weekly-trend:${isoWeekKey(new Date('2026-06-05T10:00:00Z'))}`);
  });

  it('本周无 high-value 产品 → 不入队', async () => {
    const { sb, inserted } = makeSb({ products: [] });
    const r = await enqueueWeeklyTrend(sb);
    expect(r.enqueued).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});
