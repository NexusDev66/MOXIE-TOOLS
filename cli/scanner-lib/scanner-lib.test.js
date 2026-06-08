/**
 * T4 scanner-lib 单测 · node:test（内置，无需依赖）
 * 跑: node --test cli/scanner-lib/*.test.js   (Node 24 起不再把目录当测试发现路径，要点名 glob)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRobots, isDisallowed } from './robots.js';
import { extractProductLinks } from './html-extract.js';
import { nextUA, uaForKey, UA_POOL_SIZE } from './ua-pool.js';
import { throttle, _resetRateLimit } from './rate-limit.js';
import { recordFailure, recordSuccess, _resetFailCounts, FEISHU_FAIL_THRESHOLD } from './feishu.js';

// ───── robots ─────
test('parseRobots: Disallow / 全站禁', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /');
  assert.equal(isDisallowed(rules, '/'), true);
  assert.equal(isDisallowed(rules, '/new'), true);
});

test('parseRobots: 只禁部分路径', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /admin\nDisallow: /api');
  assert.equal(isDisallowed(rules, '/admin/x'), true);
  assert.equal(isDisallowed(rules, '/api'), true);
  assert.equal(isDisallowed(rules, '/'), false);
  assert.equal(isDisallowed(rules, '/products'), false);
});

test('parseRobots: 针对别的 UA 的 Disallow 不影响我们', () => {
  const rules = parseRobots('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private');
  assert.equal(isDisallowed(rules, '/'), false);       // BadBot 的 / 不算我们头上
  assert.equal(isDisallowed(rules, '/private'), true); // * 的生效
});

test('parseRobots: 空 robots = 不禁任何', () => {
  const rules = parseRobots('');
  assert.equal(isDisallowed(rules, '/'), false);
});

// ───── html-extract ─────
test('extractProductLinks: 抽外部产品官网，排除自链/社交/目录站', () => {
  const html = `
    <a href="https://cursor.com">Cursor AI</a>
    <a href="https://fazier.com/about">关于本站</a>
    <a href="https://twitter.com/x">Twitter</a>
    <a href="https://github.com/y">GitHub</a>
    <a href="https://producthunt.com/posts/z">PH</a>
    <a href="https://notion.so">Notion 工作空间</a>
  `;
  const out = extractProductLinks(html, 'https://fazier.com/', 'fazier.com');
  const domains = out.map(o => new URL(o.link).host.replace(/^www\./, ''));
  assert.ok(domains.includes('cursor.com'));
  assert.ok(domains.includes('notion.so'));
  assert.ok(!domains.includes('fazier.com'));        // 自链排除
  assert.ok(!domains.includes('twitter.com'));        // 社交排除
  assert.ok(!domains.includes('github.com'));         // 社交排除
  assert.ok(!domains.includes('producthunt.com'));    // 目录站排除
});

test('extractProductLinks: 同 (url+text) 去重', () => {
  const html = `<a href="https://a.com">Tool A</a><a href="https://a.com">Tool A</a>`;
  const out = extractProductLinks(html, 'https://fazier.com/', 'fazier.com');
  assert.equal(out.length, 1);
});

test('extractProductLinks: 锚文本太短跳过', () => {
  const html = `<a href="https://a.com">x</a><a href="https://b.com">Good Name</a>`;
  const out = extractProductLinks(html, 'https://fazier.com/', 'fazier.com');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Good Name');
});

// ───── ua-pool ─────
test('ua-pool: nextUA 轮询遍历全池', () => {
  const seen = new Set();
  for (let i = 0; i < UA_POOL_SIZE; i++) seen.add(nextUA());
  assert.equal(seen.size, UA_POOL_SIZE);
});

test('ua-pool: uaForKey 同 key 稳定', () => {
  assert.equal(uaForKey('fazier.com'), uaForKey('fazier.com'));
});

// ───── rate-limit ─────
test('rate-limit: 同域第二次请求被 sleep ≥ 阈值', async () => {
  _resetRateLimit();
  await throttle('x.com', 50);   // 首次几乎不等
  const t0 = Date.now();
  await throttle('x.com', 50);   // 第二次要等 ≥ 50ms
  assert.ok(Date.now() - t0 >= 45);
});

// ───── feishu ─────
test('feishu: 连续失败达阈值触发告警（无 webhook 时返回 true 表示判定触发）', async () => {
  _resetFailCounts();
  delete process.env.FEISHU_WEBHOOK;   // 无 webhook：sendFeishuAlert 返回 false，但 recordFailure 仍判定触发
  let triggered = false;
  for (let i = 0; i < FEISHU_FAIL_THRESHOLD; i++) {
    triggered = await recordFailure('badsite', 'HTTP 500');
  }
  assert.equal(triggered, true);   // 第 3 次触发
});

test('feishu: 成功清零失败计数', async () => {
  _resetFailCounts();
  await recordFailure('s', 'e');
  await recordFailure('s', 'e');
  recordSuccess('s');              // 清零
  const triggered = await recordFailure('s', 'e');  // 现在只是第 1 次
  assert.equal(triggered, false);
});
