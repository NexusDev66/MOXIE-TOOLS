/**
 * Per-domain 限速（T4 AC-3）
 *
 * 同一域名两次请求间隔 ≥ MIN_INTERVAL_MS（默认 1s）+ 小抖动。
 * 跨域名不互相阻塞。
 */

const DEFAULT_MIN_INTERVAL_MS = 1000;
const JITTER_MS = 300;

/** domain -> 上次请求时间戳 */
const lastAt = new Map();

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 抓某域名前调用，必要时 sleep 到满足间隔。
 * @param {string} domain
 * @param {number} [minIntervalMs]
 */
export async function throttle(domain, minIntervalMs = DEFAULT_MIN_INTERVAL_MS) {
  const last = lastAt.get(domain) ?? 0;
  const elapsed = Date.now() - last;
  const wait = Math.max(0, minIntervalMs - elapsed) + Math.random() * JITTER_MS;
  if (wait > 0) await sleep(wait);
  lastAt.set(domain, Date.now());
}

/** 测试用 */
export function _resetRateLimit() {
  lastAt.clear();
}
