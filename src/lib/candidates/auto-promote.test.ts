import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildAutoPromotePayload,
  autoPromoteCandidates,
  autoPromoteThreshold,
  DEFAULT_AUTO_PROMOTE_THRESHOLD,
  type AutoPromoteCandidate,
} from './auto-promote';

const fullCand = (over: Partial<AutoPromoteCandidate> = {}): AutoPromoteCandidate => ({
  id: 1,
  tool_name_hint: 'Cursor',
  tool_domain: 'cursor.com',
  tool_url: 'https://cursor.com',
  occurrence_count: 3,
  ai_enrichment_jsonb: {
    features: 'AI 原生 IDE,深度集成 Agent,可多文件编辑',
    use_cases: '给程序员写代码用',
    pricing: '免费+订阅',
    founders: 'Anysphere',
    tech_stack: ['VSCode'],
  },
  screenshot_url: 'https://x/c.png',
  ...over,
});

describe('buildAutoPromotePayload', () => {
  it('齐全候选 → 合法 payload(slug 派生 / tagline 截 features / source 标记)', () => {
    const r = buildAutoPromotePayload(fullCand());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.slug).toBe('cursor');
    expect(r.payload.name).toBe('Cursor');
    expect(r.payload.domain).toBe('cursor.com');
    expect(r.payload.tagline.length).toBeGreaterThan(0);
    expect(r.payload.tagline.length).toBeLessThanOrEqual(30);
    expect(r.payload.description).toBeTruthy();
    expect((r.payload.source as { auto_promote?: boolean }).auto_promote).toBe(true);
  });

  it('无 domain → 失败', () => {
    const r = buildAutoPromotePayload(fullCand({ tool_domain: '' }));
    expect(r.ok).toBe(false);
  });

  it('name 缺失时退用 domain', () => {
    const r = buildAutoPromotePayload(fullCand({ tool_name_hint: null }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.name).toBe('cursor.com');
  });
});

function makeSb(candidates: AutoPromoteCandidate[]) {
  return {
    from(table: string) {
      const qb = {
        select: () => qb,
        eq: () => qb,
        order: () => qb,
        limit: () => qb,
        then: (res: (r: unknown) => unknown) =>
          Promise.resolve(
            table === 'moxie_trend_candidates' ? { data: candidates, error: null } : { data: [], error: null },
          ).then(res),
      };
      return qb;
    },
  } as never;
}

describe('autoPromoteCandidates', () => {
  it('低于阈值 → 全部 skipped,不调 promote', async () => {
    const promote = vi.fn();
    // 无 AI 补全 + 无截图 → 分仅 name+occurrence(=30),低于阈值 70
    const lowCand = fullCand({ ai_enrichment_jsonb: null, screenshot_url: null });
    const summary = await autoPromoteCandidates(
      { threshold: 70, limit: 10 },
      { sb: makeSb([lowCand]), promote: promote as never },
    );
    expect(summary.skipped).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(promote).not.toHaveBeenCalled();
  });

  it('达阈值 → 调 promote 升级', async () => {
    const promote = vi.fn(async () => ({ ok: true, productId: 100, inserted: true }));
    const summary = await autoPromoteCandidates(
      { threshold: 50, limit: 10 },
      { sb: makeSb([fullCand()]), promote: promote as never },
    );
    expect(summary.promoted).toBe(1);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(summary.outcomes[0]).toMatchObject({ candidateId: 1, status: 'promoted', productId: 100 });
  });

  it('达阈值但拼不出 payload(无 domain) → skipped,不调 promote', async () => {
    const promote = vi.fn();
    const summary = await autoPromoteCandidates(
      { threshold: 50, limit: 10 },
      { sb: makeSb([fullCand({ tool_domain: '' })]), promote: promote as never },
    );
    expect(summary.skipped).toBe(1);
    expect(promote).not.toHaveBeenCalled();
  });
});

describe('autoPromoteThreshold（env）', () => {
  afterEach(() => {
    delete process.env.CANDIDATE_AUTO_PROMOTE_THRESHOLD;
  });
  it('未设 → 默认', () => {
    delete process.env.CANDIDATE_AUTO_PROMOTE_THRESHOLD;
    expect(autoPromoteThreshold()).toBe(DEFAULT_AUTO_PROMOTE_THRESHOLD);
  });
  it('合法值 → 采用', () => {
    process.env.CANDIDATE_AUTO_PROMOTE_THRESHOLD = '85';
    expect(autoPromoteThreshold()).toBe(85);
  });
  it('非法值 → 回默认', () => {
    process.env.CANDIDATE_AUTO_PROMOTE_THRESHOLD = 'abc';
    expect(autoPromoteThreshold()).toBe(DEFAULT_AUTO_PROMOTE_THRESHOLD);
  });
  it('空串 → 回默认(不当 0,防全量自动升级)', () => {
    process.env.CANDIDATE_AUTO_PROMOTE_THRESHOLD = '';
    expect(autoPromoteThreshold()).toBe(DEFAULT_AUTO_PROMOTE_THRESHOLD);
    process.env.CANDIDATE_AUTO_PROMOTE_THRESHOLD = '   ';
    expect(autoPromoteThreshold()).toBe(DEFAULT_AUTO_PROMOTE_THRESHOLD);
  });
});
