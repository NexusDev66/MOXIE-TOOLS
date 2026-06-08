/**
 * robots.txt 校验工具（T4 AC-2）
 *
 * 最小可用子集：
 *   - 抓 https://<site>/robots.txt，缓存 24h
 *   - 解析 User-agent + Disallow（不支持 Allow / Crawl-delay 复杂场景）
 *   - 收集对 "*" 和我们 UA 名匹配的段
 *   - 抓不到 robots（404 / 超时）按"允许"处理（多数爬虫约定）
 *
 * 用法:
 *   import { isAllowed } from './scanner-lib/robots.js';
 *   const ok = await isAllowed('fazier.com', '/new', fetchTextFn, log);
 */

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const UA_NAME = 'MoxieTrendScanner';

/** site -> { disallow: string[], fetchedAt: number } */
const cache = new Map();

/**
 * @param {string} site            主域名（如 fazier.com）
 * @param {string} pathname        要抓的路径（如 / 或 /new）
 * @param {(url:string)=>Promise<string>} fetchText  注入的抓取函数（带超时/UA）
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<boolean>} 是否允许抓
 */
export async function isAllowed(site, pathname, fetchText, log = () => {}) {
  const rules = await loadRobots(site, fetchText, log);
  return !isDisallowed(rules, pathname || '/');
}

async function loadRobots(site, fetchText, log) {
  const cached = cache.get(site);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;

  let text = '';
  try {
    text = await fetchText(`https://${site}/robots.txt`);
  } catch (e) {
    // robots 不存在 / 抓失败 → 视为允许
    log(`    robots[${site}]: fetch 失败(${e.message})，按允许处理`);
    const empty = { disallow: [], fetchedAt: Date.now() };
    cache.set(site, empty);
    return empty;
  }

  const rules = parseRobots(text);
  cache.set(site, rules);
  log(`    robots[${site}]: ${rules.disallow.length} 条 Disallow`);
  return rules;
}

/**
 * 解析 robots.txt。从匹配的 User-agent 段收集 Disallow。
 * @param {string} text
 * @returns {{disallow: string[], fetchedAt: number}}
 */
export function parseRobots(text) {
  const lines = String(text).split(/\r?\n/);
  const disallow = [];
  let applies = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();

    if (key === 'user-agent') {
      applies = val === '*' || val.toLowerCase().includes(UA_NAME.toLowerCase());
    } else if (applies && key === 'disallow' && val) {
      disallow.push(val);
    }
  }
  return { disallow, fetchedAt: Date.now() };
}

/** 前缀匹配判断是否被拒 */
export function isDisallowed(rules, pathname) {
  return rules.disallow.some((d) => d === '/' || pathname.startsWith(d));
}

/** 测试用：清缓存 */
export function _resetRobotsCache() {
  cache.clear();
}
