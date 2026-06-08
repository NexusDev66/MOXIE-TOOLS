import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * promoteCandidate server action 单测 · 4 情形
 *
 * 1) 非 admin            → { ok:false, error 含 无权限 }
 * 2) 校验失败（缺 slug）  → { ok:false }
 * 3) 分类不存在          → { ok:false, error 含 分类 }
 * 4) 正常升级            → { ok:true } + candidate status 被更新
 *
 * 策略：mock 掉 auth / products / admin client / next 缓存 / server-only
 */

let adminReturn: { userId: string; email: string | null; displayName: string | null } | null;
let categoryMap: Map<string, number>;
let candidateUpdateCalls: Array<{ id: unknown; patch: Record<string, unknown> }>;
let productUpdateCalls: Array<Record<string, unknown>>;  // T9: moxie_products 的 update(封面带入)
let upsertInserted: boolean;                              // upsertProductByDomain 返回的 inserted
let candidateScreenshot: string | null;                  // candidate.screenshot_url
let coverResult: { coverUrl: string | null; source: string; error?: string }; // captureAndStoreCover 返回

beforeEach(() => {
  vi.resetModules();
  adminReturn = { userId: 'admin-uuid', email: 'a@b.com', displayName: 'Admin' };
  categoryMap = new Map([['ai-coding', 1]]);
  candidateUpdateCalls = [];
  productUpdateCalls = [];
  upsertInserted = true;
  candidateScreenshot = null;
  coverResult = { coverUrl: 'https://x.supabase.co/storage/v1/object/public/moxie-covers/products/example-com/landing.png', source: 'screenshot' };
});

function fakeAdminClient() {
  return {
    from(table: string) {
      if (table === 'moxie_trend_candidates') {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: async (_col: string, id: unknown) => {
              candidateUpdateCalls.push({ id, patch });
              return { error: null };
            },
          }),
          // T9:封面带入读 screenshot_url;captureCandidateCover 读 tool_url/tool_domain
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { id: 1, tool_url: 'https://example.com', tool_domain: 'example.com', screenshot_url: candidateScreenshot }, error: null }) }),
          }),
        };
      }
      if (table === 'moxie_products') {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              productUpdateCalls.push(patch);
              return { error: null };
            },
          }),
        };
      }
      if (table === 'moxie_audit_logs') {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

async function loadActions() {
  vi.doMock('server-only', () => ({}));
  vi.doMock('next/cache', () => ({ revalidatePath: () => undefined }));
  vi.doMock('@/lib/admin/auth', () => ({
    getCurrentAdmin: async () => adminReturn,
  }));
  vi.doMock('@/lib/supabase/admin', () => ({
    getSupabaseAdminClient: () => fakeAdminClient(),
  }));
  vi.doMock('@/lib/sync/products', () => ({
    loadCategoryMap: async () => categoryMap,
    upsertProductByDomain: async () => ({ id: 100, slug: 'cursor-ai', inserted: upsertInserted }),
  }));
  vi.doMock('@/lib/sync/audit', () => ({ writeAuditLog: async () => undefined }));
  // T9: 截图底层(避免测试真起 Playwright/网络)
  vi.doMock('@/lib/screenshot/landing', () => ({ captureAndStoreCover: async () => coverResult }));
  return await import('./actions');
}

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const validFields = {
  slug: 'cursor-ai',
  name: 'Cursor AI',
  domain: 'cursor.com',
  tagline: 'AI 原生 IDE',
  category_slug: 'ai-coding',
  price_label: '订阅',
  domestic_available: 'partial',
  tags: '编程, IDE',
};

describe('promoteCandidate', () => {
  it('非 admin → 拒绝', async () => {
    adminReturn = null;
    const { promoteCandidate } = await loadActions();
    const res = await promoteCandidate(1, {}, fd(validFields));
    expect(res.ok).toBeFalsy();
    expect(res.error).toContain('权限');
  });

  it('缺 slug → 校验失败', async () => {
    const { promoteCandidate } = await loadActions();
    const { slug: _omit, ...bad } = validFields;
    const res = await promoteCandidate(1, {}, fd(bad));
    expect(res.ok).toBeFalsy();
    expect(res.error).toContain('slug');
  });

  it('分类不存在 → 拒绝', async () => {
    categoryMap = new Map();   // 空映射
    const { promoteCandidate } = await loadActions();
    const res = await promoteCandidate(1, {}, fd(validFields));
    expect(res.ok).toBeFalsy();
    expect(res.error).toContain('分类');
  });

  it('正常升级 → 成功 + candidate 状态更新', async () => {
    const { promoteCandidate } = await loadActions();
    const res = await promoteCandidate(42, {}, fd(validFields));
    expect(res.ok).toBe(true);
    expect(res.message).toContain('产品 #100');
    // candidate 被标 promoted
    expect(candidateUpdateCalls).toHaveLength(1);
    expect(candidateUpdateCalls[0]!.id).toBe(42);
    expect(candidateUpdateCalls[0]!.patch.status).toBe('promoted');
    expect(candidateUpdateCalls[0]!.patch.promoted_product_id).toBe(100);
  });

  // T9 复审 #3:封面带入只在新建产品时,不覆盖已存在产品的封面
  it('新建产品 + 候选有截图 → 带入 cover_url', async () => {
    upsertInserted = true;
    candidateScreenshot = 'https://x.supabase.co/storage/v1/object/public/moxie-covers/products/cursor-com/landing.png';
    const { promoteCandidate } = await loadActions();
    const res = await promoteCandidate(42, {}, fd(validFields));
    expect(res.ok).toBe(true);
    expect(productUpdateCalls).toHaveLength(1);
    expect(productUpdateCalls[0]!.cover_url).toBe(candidateScreenshot);
  });

  it('re-promote 已存在产品(inserted=false)→ 不覆盖封面', async () => {
    upsertInserted = false;            // 命中已存在 domain → UPDATE 路径
    candidateScreenshot = 'https://x.supabase.co/.../landing.png';
    const { promoteCandidate } = await loadActions();
    const res = await promoteCandidate(42, {}, fd(validFields));
    expect(res.ok).toBe(true);
    expect(productUpdateCalls).toHaveLength(0);   // 不写 cover_url,保留人工封面
  });
});

describe('dismissCandidate', () => {
  it('非 admin → 拒绝', async () => {
    adminReturn = null;
    const { dismissCandidate } = await loadActions();
    const res = await dismissCandidate(1, {}, fd({ reason: 'spam' }));
    expect(res.ok).toBeFalsy();
    expect(res.error).toContain('权限');
    // 没动 DB
    expect(candidateUpdateCalls).toHaveLength(0);
  });

  it('正常跳过 → candidate status=dismissed + 记原因', async () => {
    const { dismissCandidate } = await loadActions();
    const res = await dismissCandidate(7, {}, fd({ reason: '低质量重复' }));
    expect(res.ok).toBe(true);
    expect(candidateUpdateCalls).toHaveLength(1);
    expect(candidateUpdateCalls[0]!.id).toBe(7);
    expect(candidateUpdateCalls[0]!.patch.status).toBe('dismissed');
    expect(candidateUpdateCalls[0]!.patch.dismissed_reason).toBe('低质量重复');
  });

  it('跳过不填原因 → 用默认原因', async () => {
    const { dismissCandidate } = await loadActions();
    const res = await dismissCandidate(8, {}, fd({}));
    expect(res.ok).toBe(true);
    expect(candidateUpdateCalls[0]!.patch.dismissed_reason).toBe('admin dismissed');
  });
});

describe('captureCandidateCover (T9 截图 action)', () => {
  it('非 admin → 拒绝,不动 DB', async () => {
    adminReturn = null;
    const { captureCandidateCover } = await loadActions();
    const res = await captureCandidateCover(5, {}, fd({}));
    expect(res.ok).toBeFalsy();
    expect(res.error).toContain('权限');
    expect(candidateUpdateCalls).toHaveLength(0);
  });

  it('截图成功 → ok + 写 candidate.screenshot_url', async () => {
    const { captureCandidateCover } = await loadActions();
    const res = await captureCandidateCover(5, {}, fd({}));
    expect(res.ok).toBe(true);
    expect(res.coverUrl).toBe(coverResult.coverUrl);
    expect(res.source).toBe('screenshot');
    // 写库:candidate.screenshot_url 被更新
    expect(candidateUpdateCalls).toHaveLength(1);
    expect(candidateUpdateCalls[0]!.id).toBe(5);
    expect(candidateUpdateCalls[0]!.patch.screenshot_url).toBe(coverResult.coverUrl);
  });

  it('截图+兜底都失败 → ok:false,不写库', async () => {
    coverResult = { coverUrl: null, source: 'none', error: '截图与兜底取图均失败' };
    const { captureCandidateCover } = await loadActions();
    const res = await captureCandidateCover(5, {}, fd({}));
    expect(res.ok).toBeFalsy();
    expect(res.error).toContain('失败');
    expect(candidateUpdateCalls).toHaveLength(0);
  });
});
