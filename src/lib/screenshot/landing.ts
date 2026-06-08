import 'server-only';
import { chromium } from 'playwright-core';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 自动配图（T9 MOXIE-22）。
 *
 *   captureLandingScreenshot(url)   Playwright headless 截官网首屏(1920x1080, wait 3s)
 *   fetchFallbackImage(url)         截不到时兜底:抓 OG image，再不行 favicon
 *   captureAndStoreCover(sb, ...)   编排:截图/兜底 → 传 moxie-covers → 返回公网 URL
 *
 * captureAndStoreCover 的截图/兜底函数可注入,便于单测(mock Playwright)。
 *
 * ⚠️ serverless 适配:Vercel 函数体积装不下完整 Chromium。生产需 playwright-core +
 *    @sparticuz/chromium,executablePath 经 env CHROMIUM_EXECUTABLE_PATH 注入。
 *    本地/未配时 launch 失败 → 返回 null → 走兜底。真实截图验证延后(见任务说明)。
 */

const BUCKET = 'moxie-covers';
const VIEWPORT = { width: 1920, height: 1080 };
const WAIT_MS = 3000;
const NAV_TIMEOUT_MS = 20_000;
const MAX_IMG_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export type CoverSource = 'screenshot' | 'og' | 'favicon' | 'none';

export interface CaptureResult {
  coverUrl: string | null;
  source: CoverSource;
  error?: string;
}

/** Playwright 截首屏。任何失败(浏览器起不来/超时/导航失败)返回 null,交给兜底。 */
export async function captureLandingScreenshot(url: string): Promise<Buffer | null> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage({ viewport: VIEWPORT });
    // SSRF:拦每个请求(主文档 + 子资源 img/css/script + 重定向跳转),套同样的公网校验,
    // 不安全的(私网/localhost/非 http)直接 abort —— 防页面内嵌 <img src=http://169.254.169.254> 等
    // 让 Chromium 从服务端去请求内网。
    await page.route('**/*', async (route) => {
      try {
        if (await isSafePublicUrl(route.request().url())) await route.continue();
        else await route.abort();
      } catch {
        await route.abort();
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // 重定向落到内网 → 不截图(防 公网 URL 跳内网 的 SSRF)
    if (!(await isSafePublicUrl(page.url()))) return null;
    await page.waitForTimeout(WAIT_MS); // 等首屏渲染/动画稳定
    // 视口已是 1920x1080,直接截视口(首屏)即可;不用 clip,避免页面比视口矮时 clip 越界/留白
    const buf = await page.screenshot({ type: 'png' });
    return Buffer.from(buf);
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const OG_RE = /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]*>/i;
const CONTENT_RE = /content=["']([^"']+)["']/i;

/** 手动跟重定向 + 每跳过 SSRF 校验的 fetch(防"公网 URL 302 跳内网"绕过,同 T6 cover-import)。 */
async function safeFetch(url: string, timeoutMs = 10_000): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (!(await isSafePublicUrl(current))) return null;
      const res = await fetch(current, { redirect: 'manual', signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) return null;
        try {
          current = new URL(res.headers.get('location')!, current).toString();
        } catch {
          return null;
        }
        continue;
      }
      return res;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  const res = await safeFetch(url);
  if (!res || !res.ok) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

// raster 白名单:**不收 SVG**(可带脚本,存 public Storage 有存储型 XSS 风险)、不收未知类型
const RASTER_CT = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif',
  'image/x-icon', 'image/vnd.microsoft.icon', // favicon
]);

async function fetchImageBuf(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const res = await safeFetch(url);
  if (!res || !res.ok) return null;
  try {
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!RASTER_CT.has(contentType)) return null; // svg / 未知类型一律拒
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMG_BYTES) return null;
    return { buf, contentType };
  } catch {
    return null;
  }
}

/** 兜底取图:先 OG image,再 favicon(走 Google favicon 服务,稳定)。 */
export async function fetchFallbackImage(
  url: string,
): Promise<{ buf: Buffer; contentType: string; source: 'og' | 'favicon' } | null> {
  // 1. OG image
  const html = await fetchHtml(url);
  if (html) {
    const tag = html.match(OG_RE)?.[0];
    const ogUrl = tag?.match(CONTENT_RE)?.[1];
    if (ogUrl) {
      let abs = ogUrl;
      try {
        abs = new URL(ogUrl, url).toString();
      } catch {
        /* keep raw */
      }
      // SSRF:og:image 来自页面 HTML(攻击者可控),抓之前也要校验非内网
      if (await isSafePublicUrl(abs)) {
        const img = await fetchImageBuf(abs);
        if (img) return { ...img, source: 'og' };
      }
    }
  }
  // 2. favicon
  try {
    const host = new URL(url).host;
    const img = await fetchImageBuf(`https://www.google.com/s2/favicons?domain=${host}&sz=128`);
    if (img) return { ...img, source: 'favicon' };
  } catch {
    /* ignore */
  }
  return null;
}

function extFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('x-icon') || ct.includes('vnd.microsoft.icon')) return 'ico';
  if (ct.includes('gif')) return 'gif';
  return 'png';
}

/** 私网 / 回环 / 链路本地(云元数据) IP 判定(与 cover-import 同口径) */
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return false;
}

/** SSRF 防护:截图/抓图前校验 URL 指向公网 http(s)(拒 localhost/*.local/*.internal/私网,含 DNS 解析) */
export async function isSafePublicUrl(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (isIP(h)) return !isPrivateIp(h);
  try {
    const { address } = await lookup(h);
    return !isPrivateIp(address);
  } catch {
    return false;
  }
}

export interface CaptureDeps {
  screenshot?: (url: string) => Promise<Buffer | null>;
  fallback?: typeof fetchFallbackImage;
}

/**
 * 编排:截图(或兜底)→ 传 moxie-covers/products/<slug>/landing.<ext> → 返回公网 URL。
 * 截图与兜底都失败 → { coverUrl:null, source:'none' }(调用方据此提示)。
 */
export async function captureAndStoreCover(
  sb: SupabaseClient,
  input: { slug: string; url: string },
  deps: CaptureDeps = {},
): Promise<CaptureResult> {
  const screenshot = deps.screenshot ?? captureLandingScreenshot;
  const fallback = deps.fallback ?? fetchFallbackImage;

  // SSRF 防护:不安全 URL(私网/localhost/非 http)直接拒,不截图也不抓图
  if (!(await isSafePublicUrl(input.url))) {
    return { coverUrl: null, source: 'none', error: 'URL 不安全(私网/localhost/非 http),跳过截图' };
  }

  let buf: Buffer | null = null;
  let source: CoverSource = 'none';
  let contentType = 'image/png';

  // 1. 优先真截图
  const shot = await screenshot(input.url);
  if (shot && shot.byteLength > 0) {
    buf = shot;
    source = 'screenshot';
    contentType = 'image/png';
  } else {
    // 2. 兜底 OG / favicon
    const fb = await fallback(input.url);
    if (fb) {
      buf = fb.buf;
      source = fb.source;
      contentType = fb.contentType;
    }
  }

  if (!buf) return { coverUrl: null, source: 'none', error: '截图与兜底取图均失败' };

  // 3. 传 Storage（landing 用固定名,后缀随类型）
  const path = `products/${input.slug}/landing.${extFromContentType(contentType)}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, buf, { contentType, upsert: true });
  if (error) return { coverUrl: null, source, error: `上传失败: ${error.message}` };

  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  return { coverUrl: data?.publicUrl ?? null, source };
}
