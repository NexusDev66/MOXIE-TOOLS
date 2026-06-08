import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * AC-4: 单测 4 种情形
 *
 * 1) Missing token         → 401 MISSING_TOKEN
 * 2) Invalid payload       → 400 INVALID_PAYLOAD（缺 required field）
 * 3) New domain            → 201 + data.inserted=true
 * 4) Existing domain       → 200 + data.inserted=false
 *
 * Mock 策略：vi.mock @/lib/supabase/admin —— 返回内存版 fake client，
 * 让 fixture 控制 select/upsert 的行为
 */

const VALID_TOKEN = 'test-token-please-be-long-enough-to-be-realistic';

beforeEach(() => {
  process.env.LATEMAI_INTERNAL_TOKEN = VALID_TOKEN;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
  vi.resetModules();
});

// ─── fake supabase client builder ───
interface FakeState {
  existingDomain?: string;        // 已存在的 domain，模拟"更新"路径
  categories?: Array<{ id: number; slug: string }>;
}

function buildFakeClient(state: FakeState) {
  const cats = state.categories ?? [
    { id: 1, slug: 'ai-coding' },
    { id: 2, slug: 'llm' },
  ];

  return {
    from(table: string) {
      if (table === 'moxie_categories') {
        return {
          select: () => ({
            then: (cb: (r: { data: typeof cats; error: null }) => unknown) =>
              cb({ data: cats, error: null }),
            // supabase-js select() 是 thenable + 也支持继续链
          }),
          // 简化：调用方用的是 `.from('moxie_categories').select('id, slug')`，await 返回 array
        };
      }
      if (table === 'moxie_products') {
        return {
          // select('id').eq('domain', val).maybeSingle()
          select: (_cols: string) => ({
            eq: (col: string, val: string) => ({
              maybeSingle: async () => {
                if (col === 'domain' && val === state.existingDomain) {
                  return { data: { id: 42 }, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
          // INSERT 路径（新 domain）
          insert: (row: { slug: string }) => ({
            select: () => ({
              single: async () => ({
                data: { id: 100, slug: row.slug },
                error: null,
              }),
            }),
          }),
          // UPDATE 路径（已存在 domain）
          update: (row: { slug: string }) => ({
            eq: (_col: string, id: number) => ({
              select: () => ({
                single: async () => ({
                  data: { id, slug: row.slug },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'moxie_audit_logs') {
        return {
          insert: async (_row: unknown) => ({ data: null, error: null }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

async function loadRouteWithFake(state: FakeState) {
  vi.doMock('@/lib/supabase/admin', () => ({
    getSupabaseAdminClient: () => buildFakeClient(state),
    _resetAdminClient: () => undefined,
  }));
  // server-only 在测试环境无意义，shim 成空
  vi.doMock('server-only', () => ({}));
  // loadCategoryMap 内部用 await sb.from('moxie_categories').select(...)
  // 我们的 fake 用 thenable 直接 resolve；如果 SDK 行为变化导致 fake 不兼容，下面这个补丁让 loadCategoryMap 走单独实现
  vi.doMock('@/lib/sync/products', async () => {
    const real = await vi.importActual<typeof import('@/lib/sync/products')>(
      '@/lib/sync/products',
    );
    return {
      ...real,
      loadCategoryMap: async () => {
        return new Map<string, number>([
          ['ai-coding', 1],
          ['llm', 2],
        ]);
      },
    };
  });
  const mod = await import('./route');
  return mod;
}

function makeReq(opts: {
  headers?: Record<string, string>;
  body?: unknown;
}): NextRequest {
  // NextRequest 的 init 类型比标准 RequestInit 稍紧（signal 不允许 null）
  // 直接构造一个最小 shape 让 ts 走 NextRequest 的重载
  return new NextRequest('http://localhost/api/internal/products', {
    method: 'POST',
    headers: opts.headers ?? {},
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const validBody = {
  slug: 'cursor-ai',
  name: 'Cursor AI',
  domain: 'cursor.com',
  tagline: 'AI 原生 IDE',
  category_slug: 'ai-coding',
  tags: ['编程', 'IDE'],
  price_label: '$20/月',
  domestic_available: 'partial' as const,
};

describe('POST /api/internal/products', () => {
  // ─── 1. Missing token → 401 ───
  it('rejects request without Authorization header → 401 MISSING_TOKEN', async () => {
    const { POST } = await loadRouteWithFake({});
    const res = await POST(makeReq({ body: validBody }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MISSING_TOKEN');
  });

  // ─── 2. Invalid payload → 400 ───
  it('rejects body missing required field → 400 INVALID_PAYLOAD', async () => {
    const { POST } = await loadRouteWithFake({});
    const { slug: _omit, ...badBody } = validBody;   // eslint-disable-line @typescript-eslint/no-unused-vars
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: badBody,
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PAYLOAD');
    expect(body.error.field).toBe('slug');
  });

  // ─── 3. New domain → 201 + inserted=true ───
  it('creates new product for new domain → 201 inserted=true', async () => {
    const { POST } = await loadRouteWithFake({ existingDomain: undefined });
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: validBody,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.inserted).toBe(true);
    expect(body.data.domain).toBe('cursor.com');
    expect(body.data.status).toBe('pending');
    expect(typeof body.data.id).toBe('number');
  });

  // ─── 4. Existing domain → 200 + inserted=false ───
  it('updates existing product for repeated domain → 200 inserted=false', async () => {
    const { POST } = await loadRouteWithFake({ existingDomain: 'cursor.com' });
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { ...validBody, tagline: 'Updated tagline' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.inserted).toBe(false);
    expect(body.data.id).toBe(42);
    expect(body.data.status).toBe('pending');
  });
});
