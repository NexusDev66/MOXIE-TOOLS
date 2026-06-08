import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { notifyGoogleIndexing } from './indexing';

/**
 * T7 AC-3 单测:GSC Indexing 客户端（mock fetch，不打真 Google）。
 * 用临时生成的 RSA key 当服务账号私钥,真实走一遍 JWT 签名逻辑。
 */

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SA_JSON = JSON.stringify({
  client_email: 'indexing-bot@proj.iam.gserviceaccount.com',
  private_key: privateKey,
});

beforeEach(() => {
  delete process.env.GOOGLE_INDEXING_SA;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notifyGoogleIndexing', () => {
  it('未配 SA → skipped,且不发任何请求', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await notifyGoogleIndexing('https://latemai.com/articles/x');
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('配了 SA → 签 JWT 换 token 再调 Indexing API,ok=true', async () => {
    process.env.GOOGLE_INDEXING_SA = SA_JSON;
    const calls: Array<{ url: string; init: { body?: unknown; headers?: Record<string, string> } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: unknown; headers?: Record<string, string> }) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('oauth2.googleapis.com')) {
          return { ok: true, json: async () => ({ access_token: 'ya29.fake-token' }) };
        }
        return { ok: true, text: async () => '', json: async () => ({}) };
      }),
    );

    const r = await notifyGoogleIndexing('https://latemai.com/articles/hello', 'URL_UPDATED');
    expect(r.ok).toBe(true);

    // 1) token 端点:jwt-bearer 授权
    const tokenCall = calls.find((c) => c.url.includes('oauth2.googleapis.com'))!;
    expect(String(tokenCall.init.body)).toContain('jwt-bearer');
    expect(String(tokenCall.init.body)).toContain('assertion=');

    // 2) indexing 端点:带 Bearer token + 正确 payload
    const idxCall = calls.find((c) => c.url.includes('indexing.googleapis.com'))!;
    expect(idxCall.init.headers?.Authorization).toBe('Bearer ya29.fake-token');
    expect(JSON.parse(String(idxCall.init.body))).toEqual({
      url: 'https://latemai.com/articles/hello',
      type: 'URL_UPDATED',
    });
  });

  it('Indexing API 返回错误 → ok:false + error,不抛', async () => {
    process.env.GOOGLE_INDEXING_SA = SA_JSON;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('oauth2.googleapis.com')) {
          return { ok: true, json: async () => ({ access_token: 't' }) };
        }
        return { ok: false, status: 403, text: async () => 'permission denied' };
      }),
    );
    const r = await notifyGoogleIndexing('https://latemai.com/articles/x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('403');
  });

  it('SA JSON 非法 → 当作未配,skipped', async () => {
    process.env.GOOGLE_INDEXING_SA = 'not-json';
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await notifyGoogleIndexing('https://latemai.com/articles/x');
    expect(r.skipped).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
});
