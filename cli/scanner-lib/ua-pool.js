/**
 * User-Agent 池（T4 AC-3）
 *
 * 5 个 UA 轮换 —— 降低被单一 UA 指纹识别/封禁的概率。
 * 都标明 MoxieTrendScanner 身份 + 联系地址，保持透明合规
 * （不伪装成真实浏览器骗过 robots，只是分散指纹）。
 */

const POOL = [
  'Mozilla/5.0 (compatible; MoxieTrendScanner/1.0; +https://latemai.com/install/agent.md)',
  'Mozilla/5.0 (X11; Linux x86_64; MoxieTrendScanner/1.0; +https://latemai.com/install/agent.md)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15; MoxieTrendScanner/1.0; +https://latemai.com/install/agent.md)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; MoxieTrendScanner/1.0; +https://latemai.com/install/agent.md)',
  'MoxieTrendScanner/1.0 (+https://latemai.com/install/agent.md)',
];

let idx = 0;

/** 轮询取下一个 UA */
export function nextUA() {
  const ua = POOL[idx % POOL.length];
  idx += 1;
  return ua;
}

/** 按 key（如域名）稳定取一个 UA —— 同一站每次用同一 UA，更像正常客户端 */
export function uaForKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return POOL[Math.abs(h) % POOL.length];
}

export const UA_POOL_SIZE = POOL.length;
