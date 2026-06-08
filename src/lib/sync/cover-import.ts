import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * 文章图片自动 import（T6 AC-4）。
 *
 * 把 cover_url + body_html 里的**外部 http(s) 图片** fetch 下来，
 * 传到 Supabase Storage 的 `moxie-covers` bucket，再把链接替换成 Storage 公网 URL。
 * —— 目的：文章不依赖外站图床（防盗链/失效/合规），自托管封面与内图。
 *
 * 稳妥策略：
 *   - 只处理 http(s) 图片；已在我们 Storage 上的跳过（不重复传）
 *   - **SSRF 防护**：拒私网 / localhost / 云元数据地址（含 DNS 解析后判私网）
 *   - 单图限大小 MAX_BYTES、content-type 必须在 raster 白名单（**不收 SVG**，防存储型 XSS）
 *   - 整篇限 MAX_IMAGES 张；**并发** CONCURRENCY 抓（控总耗时，避免 serverless 超时）
 *   - **任何单图失败都不阻断入库**：保留原链接，计入 failed
 */

const BUCKET = 'moxie-covers';
const MAX_IMAGES = 20;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const FETCH_TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;
const MAX_REDIRECTS = 3;

const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;

// raster 白名单（不含 svg：SVG 可带脚本，存 public Storage 有存储型 XSS 风险）
const CT_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export interface ImageImportResult {
  bodyHtml: string | null;
  coverUrl: string | null;
  imported: number;
  failed: number;
  skipped: number;
}

export interface ImageImportInput {
  slug: string;
  bodyHtml?: string | null;
  coverUrl?: string | null;
}

/** 从 body_html 抽出所有 <img src>，加上 cover_url，去重 */
function collectImageUrls(input: ImageImportInput): string[] {
  const urls = new Set<string>();
  if (input.coverUrl) urls.add(input.coverUrl);
  if (input.bodyHtml) {
    for (const m of input.bodyHtml.matchAll(IMG_SRC_RE)) {
      const src = (m[1] ?? m[2] ?? '').trim();
      if (src) urls.add(src);
    }
  }
  return [...urls];
}

/** 是否该 import：http(s) 且不是已在我们 Storage 上的（同步初筛） */
function shouldImport(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const ownHost = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  if (ownHost && url.startsWith(ownHost)) return false;
  if (url.includes(`/storage/v1/object/public/${BUCKET}/`)) return false;
  return true;
}

/** 私网 / 回环 / 链路本地（云元数据） IP 判定 */
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;       // link-local / 169.254.169.254 元数据
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
    if (v.startsWith('fe80')) return true;                      // link-local
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);           // IPv4-mapped
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return false;
}

/** SSRF 防护：解析 host，拒 localhost / *.local / *.internal / 私网 IP（含 DNS 解析结果） */
async function isSafePublicUrl(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (isIP(h)) return !isPrivateIp(h);
  try {
    const { address } = await lookup(h);   // 域名解析后判私网（防 DNS rebinding 到内网）
    return !isPrivateIp(address);
  } catch {
    return false; // 解析不了，保守拒
  }
}

/** 拉一张图，校验类型/大小。失败/不合格返回 null。
 *  手动跟重定向：每跳都重新过 isSafePublicUrl —— 防止公网 URL 302 跳到内网绕过 SSRF 检查。 */
async function fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(currentUrl, { redirect: 'manual', signal: ctrl.signal });

      // 3xx：手动跟，但目标必须 http(s) 且非内网，最多 MAX_REDIRECTS 跳
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) return null;
        let next: string;
        try { next = new URL(res.headers.get('location')!, currentUrl).toString(); } catch { return null; }
        if (!/^https?:\/\//i.test(next)) return null;       // 只跟 http(s)，拒 file:/gopher: 等
        if (!(await isSafePublicUrl(next))) return null;     // 重定向目标不能指向内网（封 SSRF 绕过）
        currentUrl = next;
        continue;
      }

      if (!res.ok) return null;
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!CT_EXT[contentType]) return null;   // 只收 raster 白名单（svg / 未知类型拒）
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len && len > MAX_BYTES) return null;  // content-length 先挡一道
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
      return { bytes: buf, contentType };
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 上传一张图到 Storage，返回公网 URL；失败返回 null。 */
async function uploadOne(sb: SupabaseClient, slug: string, url: string): Promise<string | null> {
  const img = await fetchImage(url);
  if (!img) return null;
  const ext = CT_EXT[img.contentType] ?? 'bin';
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const path = `articles/${slug}/${hash}.${ext}`;

  const { error } = await sb.storage.from(BUCKET).upload(path, img.bytes, {
    contentType: img.contentType,
    upsert: true,
  });
  if (error) return null;

  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  return data?.publicUrl ?? null;
}

/** 把 haystack 里某个 old URL 的所有出现替换为 new URL */
function replaceAll(haystack: string, from: string, to: string): string {
  return haystack.split(from).join(to);
}

/** 并发上限执行（控总耗时，避免 serverless 超时） */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type ImgOutcome =
  | { url: string; status: 'ok'; newUrl: string }
  | { url: string; status: 'failed' | 'skipped' };

/**
 * 主入口：import cover_url + body_html 内图 → Storage，替换链接。
 * 永不抛错（单图失败计入 failed，保留原链接）。
 */
export async function importArticleImages(
  sb: SupabaseClient,
  input: ImageImportInput,
): Promise<ImageImportResult> {
  let bodyHtml = input.bodyHtml ?? null;
  let coverUrl = input.coverUrl ?? null;
  let imported = 0;
  let failed = 0;
  let skipped = 0;

  const all = collectImageUrls(input);
  const candidates = all.filter(shouldImport);
  skipped += all.length - candidates.length;

  const capped = candidates.slice(0, MAX_IMAGES);
  skipped += candidates.length - capped.length; // 超额算跳过

  // 并发抓+传，收集结果（不在并发里改字符串，避免竞态）
  const outcomes = await mapWithConcurrency<string, ImgOutcome>(capped, CONCURRENCY, async (url) => {
    try {
      if (!(await isSafePublicUrl(url))) return { url, status: 'skipped' };
      const newUrl = await uploadOne(sb, input.slug, url);
      return newUrl ? { url, status: 'ok', newUrl } : { url, status: 'failed' };
    } catch {
      // 任何意外异常（Storage 抛错、DNS 抛错等）都降级为单图失败，
      // 绝不让它冒泡阻断整篇入库（兑现 docstring「永不抛错」承诺）
      return { url, status: 'failed' };
    }
  });

  for (const r of outcomes) {
    if (r.status === 'skipped') skipped++;
    else if (r.status === 'failed') failed++;
  }

  // 成功的按 URL 长度降序替换：避免短 URL 是长 URL 子串时串扰（如 a.png vs a.png?v=2）
  const oks = outcomes.filter((r): r is Extract<ImgOutcome, { status: 'ok' }> => r.status === 'ok')
    .sort((a, b) => b.url.length - a.url.length);
  for (const r of oks) {
    if (bodyHtml) bodyHtml = replaceAll(bodyHtml, r.url, r.newUrl);
    if (coverUrl === r.url) coverUrl = r.newUrl;
    else if (coverUrl) coverUrl = replaceAll(coverUrl, r.url, r.newUrl);
    imported++;
  }

  return { bodyHtml, coverUrl, imported, failed, skipped };
}
