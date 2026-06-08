/**
 * HTML 启发式提取（T4 · 8 个 P1 站没有干净 RSS，从首页 HTML 抓外链）
 *
 * 思路（跟主项目 Phase 1 同一套，移植成 .js）：
 *   1. 抓出所有 <a href> 锚点
 *   2. href 解析成绝对 URL
 *   3. 取锚点可见文本（去标签 + 解实体）做 name_hint
 *   4. 过滤：社交/CDN/短链/目录站自身
 *   5. 同页 (url+text) 去重
 *
 * 调用方负责再做 normalizeUrl + productKey。
 */

const A_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;

const SOCIAL = new Set([
  'twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'youtube.com', 'youtu.be', 'reddit.com', 'discord.com',
  'discord.gg', 't.me', 'github.com', 'medium.com', 'substack.com',
]);
const INFRA = new Set([
  'cloudflare.com', 'googleapis.com', 'gstatic.com', 'google.com',
  'googletagmanager.com', 'cdn.jsdelivr.net', 'unpkg.com',
]);
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'lnkd.in']);

/** PRD 列出的目录站本身（互相导流会污染候选池） */
const DIRECTORY_SITES = new Set([
  'producthunt.com', 'twelve.tools', 'fazier.com', 'turbo0.com',
  'findly.tools', 'uneed.best', 'peerpush.net', 'toolfame.com',
  'tinylaunch.com', 'neeed.directory', 'trustmrr.com', 'foundrlist.com',
  'indie.deals', 'microlaunch.net', 'startupslab.site', 'trylaunch.ai',
  'rankinpublic.xyz', 'toolfolio.io', 'confettisaas.com', 'launch.cab',
  'go-publicly.com', 'indietools.app', 'selected.site', 'saascity.io',
  'endors.me', 'everfeatured.com', 'stackovery.com', 'auraplusplus.com',
  'shipstry.com', 'betterlaunch.co', 'desifounder.com', 'oksaas.co',
  'showmeyour.site', 'agentwork.tools', 'marketingdb.live', 'saasstars.com',
]);

function domainOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function isProductCandidate(url, sourceSite) {
  const d = domainOf(url);
  if (!d) return false;
  if (d === sourceSite || d.endsWith('.' + sourceSite)) return false;
  if (SOCIAL.has(d) || INFRA.has(d) || SHORTENERS.has(d)) return false;
  if (DIRECTORY_SITES.has(d)) return false;
  return true;
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' };

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => safeCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITY[n.toLowerCase()] ?? m);
}
function safeCode(c) {
  if (!Number.isFinite(c) || c <= 0 || c > 0x10ffff) return '';
  try { return String.fromCodePoint(c); } catch { return ''; }
}
function stripText(html) {
  return decodeEntities(html.replace(TAG_RE, ' ')).replace(WS_RE, ' ').trim();
}

/**
 * 从 HTML 抽出指向外部产品官网的 (link, title) 列表。
 * @param {string} html
 * @param {string} baseUrl  页面 URL（解析相对链接）
 * @param {string} sourceSite  当前目录站域名（排除自链）
 * @param {number} [cap]  上限
 * @returns {Array<{link:string, title:string}>}
 */
export function extractProductLinks(html, baseUrl, sourceSite, cap = 200) {
  const out = [];
  const seen = new Set();
  let base;
  try { base = new URL(baseUrl); } catch { return out; }

  const baseTag = html.match(/<base[^>]+href=["']([^"']+)["']/i)?.[1];
  if (baseTag) { try { base = new URL(baseTag, base); } catch { /* keep */ } }

  for (const m of html.matchAll(A_RE)) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const hrefM = attrs.match(HREF_RE);
    if (!hrefM) continue;
    const href = (hrefM[1] ?? hrefM[2] ?? hrefM[3] ?? '').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') ||
        href.startsWith('tel:') || href.startsWith('javascript:')) continue;

    let abs;
    try { abs = new URL(href, base).toString(); } catch { continue; }
    if (!isProductCandidate(abs, sourceSite)) continue;

    const text = stripText(inner);
    if (!text || text.length < 2) continue;

    const key = `${abs}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ link: abs, title: text });
    if (out.length >= cap) break;
  }
  return out;
}

export { domainOf, isProductCandidate, decodeEntities };
