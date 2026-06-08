import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * T6 AC-5 单测：
 *   1) Missing token        → 401 MISSING_TOKEN
 *   2) Invalid payload      → 400 INVALID_PAYLOAD (缺 slug)
 *   3) New slug             → 201 inserted=true, status=published
 *   4) Existing slug        → 200 inserted=false
 *   5) 图片 import          → cover_url + body 内图传 Storage、链接替换、images.imported>0
 *
 * Mock：vi.mock @/lib/supabase/admin 返回内存 fake（含 storage）；global fetch 打桩返回图片。
 */

const VALID_TOKEN = 'test-token-please-be-long-enough-to-be-realistic';

beforeEach(() => {
  process.env.LATEMAI_INTERNAL_TOKEN = VALID_TOKEN;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FakeState {
  existingSlug?: string;
  /** 让 storage.upload 抛异常（验异常不阻断入库） */
  storageThrows?: boolean;
  /** 捕获写入 moxie_articles 的 row（断言图片链接替换用） */
  captured?: { insert?: Record<string, unknown>; update?: Record<string, unknown> };
}

function buildFakeClient(state: FakeState) {
  state.captured = {};
  return {
    from(table: string) {
      if (table === 'moxie_articles') {
        return {
          select: (_cols: string) => ({
            eq: (col: string, val: string) => ({
              maybeSingle: async () => {
                if (col === 'slug' && val === state.existingSlug) {
                  return { data: { id: 42, status: 'published' }, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            state.captured!.insert = row;
            return {
              select: () => ({
                single: async () => ({
                  data: { id: 100, slug: row.slug, status: row.status },
                  error: null,
                }),
              }),
            };
          },
          update: (row: Record<string, unknown>) => {
            state.captured!.update = row;
            return {
              eq: (_col: string, id: number) => ({
                select: () => ({
                  single: async () => ({
                    data: { id, slug: state.existingSlug, status: 'published' },
                    error: null,
                  }),
                }),
              }),
            };
          },
        };
      }
      if (table === 'moxie_audit_logs') {
        return { insert: async (_row: unknown) => ({ data: null, error: null }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    storage: {
      from(_bucket: string) {
        return {
          upload: async (_path: string, _body: unknown, _opts: unknown) => {
        if (state.storageThrows) throw new Error('storage network blew up');
        return { data: { path: _path }, error: null };
      },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/moxie-covers/${path}` },
          }),
        };
      },
    },
  };
}

async function loadRouteWithFake(state: FakeState) {
  vi.doMock('@/lib/supabase/admin', () => ({
    getSupabaseAdminClient: () => buildFakeClient(state),
    _resetAdminClient: () => undefined,
  }));
  vi.doMock('server-only', () => ({}));
  // cover-import 的 SSRF 检查会对外链域名做 DNS 解析；测试里 mock 成公网 IP，避免真打网络
  vi.doMock('node:dns/promises', () => ({
    lookup: async () => ({ address: '93.184.216.34', family: 4 }),
  }));
  const mod = await import('./route');
  return mod;
}

/** 打桩 global fetch：任意 url 返回一张 1KB PNG */
function stubFetchImage() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/png' : '1024') },
      arrayBuffer: async () => new ArrayBuffer(1024),
    })),
  );
}

function makeReq(opts: { headers?: Record<string, string>; body?: unknown }): NextRequest {
  return new NextRequest('http://localhost/api/internal/articles', {
    method: 'POST',
    headers: opts.headers ?? {},
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const validBody = {
  slug: 'cursor-vs-copilot',
  title: 'Cursor vs Copilot 横评',
  excerpt: '两大 AI 编程助手对比',
  category: '横评',
  read_minutes: 8,
};

describe('POST /api/internal/articles', () => {
  it('缺 Authorization → 401 MISSING_TOKEN', async () => {
    const { POST } = await loadRouteWithFake({});
    const res = await POST(makeReq({ body: validBody }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('MISSING_TOKEN');
  });

  it('缺 required field(slug) → 400 INVALID_PAYLOAD', async () => {
    const { POST } = await loadRouteWithFake({});
    const { slug: _omit, ...badBody } = validBody;   // eslint-disable-line @typescript-eslint/no-unused-vars
    const res = await POST(
      makeReq({ headers: { authorization: `Bearer ${VALID_TOKEN}` }, body: badBody }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_PAYLOAD');
    expect(body.error.field).toBe('slug');
  });

  it('新 slug → 201 inserted=true, status=published', async () => {
    const { POST } = await loadRouteWithFake({ existingSlug: undefined });
    const res = await POST(
      makeReq({ headers: { authorization: `Bearer ${VALID_TOKEN}` }, body: validBody }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.inserted).toBe(true);
    expect(body.data.slug).toBe('cursor-vs-copilot');
    expect(body.data.status).toBe('published');
  });

  it('同 slug → 200 inserted=false', async () => {
    const { POST } = await loadRouteWithFake({ existingSlug: 'cursor-vs-copilot' });
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { ...validBody, title: '改了标题' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inserted).toBe(false);
    expect(body.data.id).toBe(42);
  });

  it('图片 import：cover + body 内图传 Storage、链接替换、images.imported=2', async () => {
    stubFetchImage();
    const state: FakeState = { existingSlug: undefined };
    const { POST } = await loadRouteWithFake(state);
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: {
          ...validBody,
          cover_url: 'https://external.com/cover.jpg',
          body_html: '<p>看图</p><img src="https://external.com/a.png" alt="a">',
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.images.imported).toBe(2);   // cover + 1 内图
    expect(body.data.images.failed).toBe(0);

    // 写库的 row 里链接已替换成 Storage 公网 URL
    const row = state.captured!.insert!;
    expect(String(row.cover_url)).toContain('/storage/v1/object/public/moxie-covers/');
    expect(String(row.body_html)).toContain('/storage/v1/object/public/moxie-covers/');
    expect(String(row.body_html)).not.toContain('external.com');
  });

  it('图片抓取失败 → 不阻断入库，保留原链接，images.failed 计数', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })));
    const state: FakeState = { existingSlug: undefined };
    const { POST } = await loadRouteWithFake(state);
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { ...validBody, cover_url: 'https://external.com/dead.jpg' },
      }),
    );
    expect(res.status).toBe(201);   // 仍然入库成功
    const body = await res.json();
    expect(body.data.images.failed).toBe(1);
    expect(body.data.images.imported).toBe(0);
    expect(String(state.captured!.insert!.cover_url)).toBe('https://external.com/dead.jpg'); // 原链接保留
  });

  it('SSRF：私网/元数据 IP 图片被跳过(不抓不传),保留原链接', async () => {
    // fetch 若被调用直接判失败(证明根本没去抓内网)
    const fetchSpy = vi.fn(async () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(1024) }));
    vi.stubGlobal('fetch', fetchSpy);
    const state: FakeState = { existingSlug: undefined };
    const { POST } = await loadRouteWithFake(state);
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { ...validBody, cover_url: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.images.imported).toBe(0);
    expect(body.data.images.skipped).toBe(1);   // 私网被跳过
    expect(fetchSpy).not.toHaveBeenCalled();      // 根本没发请求到内网
    expect(String(state.captured!.insert!.cover_url)).toBe('http://169.254.169.254/latest/meta-data/');
  });

  it('SVG 被拒(防存储型 XSS)→ failed,不进 Storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/svg+xml' : '512') },
      arrayBuffer: async () => new ArrayBuffer(512),
    })));
    const state: FakeState = { existingSlug: undefined };
    const { POST } = await loadRouteWithFake(state);
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { ...validBody, cover_url: 'https://external.com/evil.svg' },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.images.imported).toBe(0);
    expect(body.data.images.failed).toBe(1);      // svg 拒收
  });

  it('SSRF 经重定向绕过被封：公网图 302 跳私网 → 不跟随,failed,绝不请求内网', async () => {
    const fetchSpy = vi.fn(async (_url: string) => ({
      status: 302,
      ok: false,
      headers: { get: (h: string) => (h.toLowerCase() === 'location' ? 'http://169.254.169.254/steal' : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const state: FakeState = { existingSlug: undefined };
    const { POST } = await loadRouteWithFake(state);
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { ...validBody, cover_url: 'https://external.com/redir.jpg' },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.images.imported).toBe(0);
    expect(body.data.images.failed).toBe(1);
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls).toContain('https://external.com/redir.jpg');   // 抓了原始公网 URL
    expect(calledUrls.some((u) => u.includes('169.254.169.254'))).toBe(false); // 绝不去抓内网目标
  });

  it('Storage upload 抛异常 → 不阻断入库(文章仍 201),该图计 failed', async () => {
    stubFetchImage();   // 图能抓到
    const state: FakeState = { existingSlug: undefined, storageThrows: true };
    const { POST } = await loadRouteWithFake(state);
    const res = await POST(
      makeReq({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { ...validBody, cover_url: 'https://external.com/cover.jpg' },
      }),
    );
    expect(res.status).toBe(201);                 // 文章照常入库
    const body = await res.json();
    expect(body.data.images.failed).toBe(1);      // 异常降级为单图失败
    expect(body.data.images.imported).toBe(0);
    expect(String(state.captured!.insert!.cover_url)).toBe('https://external.com/cover.jpg'); // 原链接保留
  });
});
