import 'server-only';
import { createSign } from 'node:crypto';

/**
 * Google Indexing API 客户端（T7 AC-3）。
 *
 * 文章发布后通知 Google「这个 URL 更新了」，加速收录。
 * 用 GCP 服务账号:本地 node:crypto 签 RS256 JWT → 换 access token → 调 Indexing API。
 * 不引 googleapis SDK（与代码库少依赖风格一致、可单测）。
 *
 * 凭据:env GOOGLE_INDEXING_SA = 服务账号 JSON 原文（含 client_email + private_key）。
 * 未配 → notifyGoogleIndexing 返回 { skipped:true }，不报错（本地/未接 GCP 时静默跳过）。
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INDEXING_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const SCOPE = 'https://www.googleapis.com/auth/indexing';
const TIMEOUT_MS = 10_000; // token / indexing 请求超时,防 Google 端点/代理卡住时调用方被无限挂起

/** 带超时的 fetch(AbortController);超时抛 AbortError */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface IndexingResult {
  ok: boolean;
  /** 未配 SA 凭据 → 跳过（非错误） */
  skipped?: boolean;
  error?: string;
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_INDEXING_SA;
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<ServiceAccount>;
    if (o.client_email && o.private_key) {
      return { client_email: o.client_email, private_key: o.private_key };
    }
  } catch {
    /* 配的不是合法 JSON */
  }
  return null;
}

function signJwt(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  ).toString('base64url');
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(sa.private_key).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(sa),
    }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('token 响应无 access_token');
  return json.access_token;
}

/**
 * 通知 Google 某 URL 已更新/删除。
 * 未配 SA → { skipped:true }；失败 → { ok:false, error }（调用方不应因此阻断主流程）。
 */
export async function notifyGoogleIndexing(
  url: string,
  type: 'URL_UPDATED' | 'URL_DELETED' = 'URL_UPDATED',
): Promise<IndexingResult> {
  const sa = loadServiceAccount();
  if (!sa) return { ok: false, skipped: true };
  try {
    const token = await getAccessToken(sa);
    const res = await fetchWithTimeout(INDEXING_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type }),
    });
    if (!res.ok) return { ok: false, error: `indexing HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
