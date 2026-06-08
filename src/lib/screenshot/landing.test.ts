import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock Playwright(AC-5):chromium.launch 返回假 browser
vi.mock('playwright-core', () => ({ chromium: { launch: vi.fn() } }));
// SSRF 检查会对外链域名做 DNS 解析;mock 成公网 IP,避免测试打真网络
vi.mock('node:dns/promises', () => ({ lookup: async () => ({ address: '93.184.216.34', family: 4 }) }));

import { chromium } from 'playwright-core';
import { captureLandingScreenshot, captureAndStoreCover, fetchFallbackImage } from './landing';

const launch = vi.mocked(chromium.launch);

function fakeBrowser() {
  const page = {
    route: vi.fn(async () => undefined), // SSRF 请求拦截(子资源)
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://cursor.com'), // 落地 URL(SSRF 校验用,DNS mock 成公网)
    waitForTimeout: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('FAKE-PNG-BYTES')),
  };
  return { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
}

beforeEach(() => {
  launch.mockReset();
  launch.mockResolvedValue(fakeBrowser() as never);
});

// mock supabase storage
function fakeSb(opts: { uploadErr?: boolean } = {}) {
  return {
    storage: {
      from(_bucket: string) {
        return {
          upload: async (_path: string, _body: unknown, _o: unknown) =>
            opts.uploadErr ? { data: null, error: { message: 'boom' } } : { data: { path: _path }, error: null },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/moxie-covers/${path}` },
          }),
        };
      },
    },
  };
}

describe('captureLandingScreenshot (mock Playwright)', () => {
  it('截图成功 → 返回 Buffer', async () => {
    const buf = await captureLandingScreenshot('https://cursor.com');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf!.byteLength).toBeGreaterThan(0);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('浏览器起不来 → 返回 null(交给兜底)', async () => {
    launch.mockRejectedValueOnce(new Error('no chromium binary'));
    const buf = await captureLandingScreenshot('https://cursor.com');
    expect(buf).toBeNull();
  });

  it('子资源 SSRF:page.route 拦截器对私网请求 abort、公网 continue', async () => {
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const page = {
      route: vi.fn(async (_p: string, h: (route: unknown) => Promise<void>) => { handler = h; }),
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => 'https://cursor.com'),
      waitForTimeout: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from('PNG')),
    };
    launch.mockResolvedValueOnce({ newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as never);
    await captureLandingScreenshot('https://cursor.com');
    expect(page.route).toHaveBeenCalled();
    expect(typeof handler).toBe('function');

    // 私网子资源 → abort(不放行)
    const priv = { request: () => ({ url: () => 'http://169.254.169.254/meta' }), continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    await handler!(priv);
    expect(priv.abort).toHaveBeenCalled();
    expect(priv.continue).not.toHaveBeenCalled();

    // 公网子资源 → continue(DNS mock 成公网)
    const pub = { request: () => ({ url: () => 'https://cdn.example.com/a.png' }), continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    await handler!(pub);
    expect(pub.continue).toHaveBeenCalled();
    expect(pub.abort).not.toHaveBeenCalled();
  });
});

describe('captureAndStoreCover', () => {
  it('截图成功 → 传 Storage,source=screenshot,路径含 products/<slug>/landing.png', async () => {
    const res = await captureAndStoreCover(fakeSb() as never, { slug: 'cursor-com', url: 'https://cursor.com' }, {
      screenshot: async () => Buffer.from('PNG'),
    });
    expect(res.source).toBe('screenshot');
    expect(res.coverUrl).toContain('products/cursor-com/landing.png');
  });

  it('截不到图 → 走兜底 OG image,source=og', async () => {
    const res = await captureAndStoreCover(fakeSb() as never, { slug: 'x-com', url: 'https://x.com' }, {
      screenshot: async () => null,
      fallback: async () => ({ buf: Buffer.from('JPG'), contentType: 'image/jpeg', source: 'og' }),
    });
    expect(res.source).toBe('og');
    expect(res.coverUrl).toContain('landing.jpg');
  });

  it('截图+兜底都失败 → coverUrl null,source none', async () => {
    const res = await captureAndStoreCover(fakeSb() as never, { slug: 'x', url: 'https://x.com' }, {
      screenshot: async () => null,
      fallback: async () => null,
    });
    expect(res.coverUrl).toBeNull();
    expect(res.source).toBe('none');
    expect(res.error).toBeTruthy();
  });

  it('上传失败 → coverUrl null + error', async () => {
    const res = await captureAndStoreCover(fakeSb({ uploadErr: true }) as never, { slug: 'x', url: 'https://x.com' }, {
      screenshot: async () => Buffer.from('PNG'),
    });
    expect(res.coverUrl).toBeNull();
    expect(res.error).toContain('上传失败');
  });

  it('SSRF:私网/元数据 URL → 拒绝,不截图不抓图', async () => {
    const screenshot = vi.fn(async () => Buffer.from('PNG'));
    const fallback = vi.fn(async () => ({ buf: Buffer.from('x'), contentType: 'image/png', source: 'og' as const }));
    const res = await captureAndStoreCover(fakeSb() as never, { slug: 'x', url: 'http://169.254.169.254/latest/meta-data/' }, {
      screenshot,
      fallback,
    });
    expect(res.coverUrl).toBeNull();
    expect(res.source).toBe('none');
    expect(screenshot).not.toHaveBeenCalled();   // 私网 URL 根本不去截
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('fetchFallbackImage SSRF:og:image 指向私网 → 跳过,改用 favicon', () => {
  it('不去抓内网 og:image', async () => {
    const fetchSpy = vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('google.com/s2/favicons')) {
        return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(100) };
      }
      // 目标页 HTML:og:image 指向私网
      return { ok: true, text: async () => '<meta property="og:image" content="http://10.0.0.1/evil.png">' };
    });
    vi.stubGlobal('fetch', fetchSpy);
    const fb = await fetchFallbackImage('https://evil.example.com');
    expect(fb?.source).toBe('favicon');          // OG 被跳过,落到 favicon
    const called = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(called.some((u) => u.includes('10.0.0.1'))).toBe(false); // 绝不抓内网 og
    vi.unstubAllGlobals();
  });

  it('SVG:og:image 是 svg → 拒收(防存储型 XSS),改用 favicon', async () => {
    const fetchSpy = vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('google.com/s2/favicons')) {
        return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(100) };
      }
      if (url.endsWith('.svg')) {
        return { ok: true, headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/svg+xml' : null) }, arrayBuffer: async () => new ArrayBuffer(50) };
      }
      return { ok: true, text: async () => '<meta property="og:image" content="https://external.com/evil.svg">' };
    });
    vi.stubGlobal('fetch', fetchSpy);
    const fb = await fetchFallbackImage('https://external.com');
    expect(fb?.source).toBe('favicon'); // svg 被拒,落到 favicon
    vi.unstubAllGlobals();
  });
});
