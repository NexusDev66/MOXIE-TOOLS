import { describe, it, expect, vi } from 'vitest';
import { processArticleJobs, type GenerateFn } from './process-jobs';
import type { GenerateResult } from '@/lib/article-gen/generate';

/**
 * T10 worker 单测。
 * fake sb 区分三类 jobs 表操作:
 *   - select(status=pending)          → 返回预置 pending 列表(仅首次)
 *   - update(...).select('id')         → 认领,返回 [{id}](claimed)
 *   - update(...).eq('id')(无 select)  → finish,记录补丁
 * generate 注入 mock,不碰真 LLM。
 */

interface JobSeed {
  id: number;
  payload: unknown;
  attempts?: number;
}

function makeSb(pending: JobSeed[]) {
  const finishCalls: Array<{ id: unknown; patch: Record<string, unknown> }> = [];
  // 回收卡死任务的 update(按 status=processing 过滤,不带 id)
  const reclaimCalls: Array<Record<string, unknown>> = [];
  let pendingServed = false;

  const sb = {
    from(_table: string) {
      const state: {
        op: 'select' | 'update';
        didSelect: boolean;
        patch: Record<string, unknown> | null;
        eqId: unknown;
      } = { op: 'select', didSelect: false, patch: null, eqId: undefined };

      const resolve = () => {
        if (state.op === 'update' && state.didSelect) {
          // 认领:返回被认领的行
          return { data: [{ id: state.eqId }], error: null };
        }
        if (state.op === 'update') {
          if (state.eqId !== undefined) {
            // 按 id 更新 = finish
            finishCalls.push({ id: state.eqId, patch: state.patch ?? {} });
          } else {
            // 不带 id(按 status=processing)= 卡死回收
            reclaimCalls.push(state.patch ?? {});
          }
          return { data: null, error: null };
        }
        // 初始 pending select(只给一次,避免死循环)
        if (pendingServed) return { data: [], error: null };
        pendingServed = true;
        return { data: pending, error: null };
      };

      const qb = {
        select: () => {
          state.didSelect = true;
          return qb;
        },
        update: (patch: Record<string, unknown>) => {
          state.op = 'update';
          state.didSelect = false; // update 后若再 select 才算认领
          state.patch = patch;
          return qb;
        },
        eq: (col: string, val: unknown) => {
          if (col === 'id') state.eqId = val;
          return qb;
        },
        lt: () => qb,
        gte: () => qb,
        order: () => qb,
        limit: () => qb,
        then: (f: (r: unknown) => unknown, r?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(f, r),
      };
      return qb;
    },
  };
  return { sb: sb as never, finishCalls, reclaimCalls };
}

const okResult = (id: number, slug: string): GenerateResult => ({
  ok: true,
  article: { id, slug, status: 'draft', inserted: true },
  meta: { provider: 'mock', model: 'm', tokens: 1, cost_usd: 0, template: 'compare' },
});

describe('processArticleJobs', () => {
  it('无 pending → 全 0', async () => {
    const { sb, finishCalls } = makeSb([]);
    const summary = await processArticleJobs({}, { sb, generate: vi.fn() as unknown as GenerateFn });
    expect(summary).toMatchObject({ picked: 0, done: 0, failed: 0, skipped: 0 });
    expect(finishCalls).toHaveLength(0);
  });

  it('生成成功 → done,finish 写 article_id/slug', async () => {
    const { sb, finishCalls } = makeSb([{ id: 5, payload: { template: 'compare', product_ids: [1, 2, 3] } }]);
    const generate = vi.fn(async () => okResult(100, 'a-b-c-compare'));
    const summary = await processArticleJobs({}, { sb, generate });
    expect(generate).toHaveBeenCalledWith([1, 2, 3], 'compare');
    expect(summary.done).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({ jobId: 5, status: 'done', articleId: 100 });
    const fin = finishCalls.find((c) => c.id === 5)!;
    expect(fin.patch.status).toBe('done');
  });

  it('生成跳过(skipped) → 标 skipped', async () => {
    const { sb } = makeSb([{ id: 6, payload: { template: 'pick', product_ids: [1] } }]);
    const generate = vi.fn(async () => ({ ok: false, skipped: true, error: 'slug 已发布' }) as GenerateResult);
    const summary = await processArticleJobs({}, { sb, generate });
    expect(summary.skipped).toBe(1);
  });

  it('生成抛错 + 未达重试上限 → 回 pending 重试', async () => {
    const { sb, finishCalls } = makeSb([{ id: 7, payload: { template: 'guide', product_ids: [1] }, attempts: 0 }]);
    const generate = vi.fn(async () => {
      throw new Error('LLM 502');
    });
    const summary = await processArticleJobs({}, { sb, generate: generate as unknown as GenerateFn });
    expect(summary.retried).toBe(1);
    expect(summary.failed).toBe(0);
    const fin = finishCalls.find((c) => c.id === 7)!;
    expect(fin.patch.status).toBe('pending');
    expect(fin.patch.last_error).toContain('LLM 502');
  });

  it('生成抛错 + 已达重试上限 → 标 failed', async () => {
    const { sb, finishCalls } = makeSb([{ id: 7, payload: { template: 'guide', product_ids: [1] }, attempts: 2 }]);
    const generate = vi.fn(async () => {
      throw new Error('LLM 502');
    });
    const summary = await processArticleJobs({}, { sb, generate: generate as unknown as GenerateFn });
    expect(summary.failed).toBe(1);
    const fin = finishCalls.find((c) => c.id === 7)!;
    expect(fin.patch.status).toBe('failed');
  });

  it('payload 缺 product_ids → 不调 generate,直接 failed', async () => {
    const { sb } = makeSb([{ id: 8, payload: { template: 'compare' } }]);
    const generate = vi.fn();
    const summary = await processArticleJobs({}, { sb, generate: generate as unknown as GenerateFn });
    expect(generate).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });

  it('每次运行都先回收卡死的 processing(超上限→failed,其余→pending)', async () => {
    const { sb, reclaimCalls } = makeSb([]);
    await processArticleJobs({}, { sb, generate: vi.fn() as unknown as GenerateFn });
    const statuses = reclaimCalls.map((p) => p.status);
    expect(statuses).toContain('failed'); // 超重试上限的回收为 failed
    expect(statuses).toContain('pending'); // 其余回收为 pending 重试
  });
});
