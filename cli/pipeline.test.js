/**
 * latemai 数据管道 · 确定性逻辑单测(node:test)
 * ------------------------------------------------------------------
 * 覆盖纯函数(无 LLM/网络):清洗闸 gate、slug 防撞 uniqueSlug、域名归一 normDomain。
 * LLM 相关(ai-clean 分类/抗注入)非确定,不在此 hard-assert。
 * 跑法:node --test cli/pipeline.test.js  (CI 已自动跑 cli/*.test.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate } from './clean-gate.mjs';
import { uniqueSlug, normDomain, orphansToPrune } from './lib.mjs';

// ── 清洗闸 gate ──
test('gate: 目录站本身硬拒', () => {
  assert.equal(gate({ name: 'launch.cab', domain: 'launch.cab', og: '', occurrence_count: 3, traffic_rank: null }).verdict, 'reject');
});
test('gate: 无信号灰产杂牌拒', () => {
  assert.equal(gate({ name: 'Evaloly', domain: 'evaloly.com', og: '', occurrence_count: 1, traffic_rank: null }).verdict, 'reject');
});
test('gate: 信号齐全真工具过', () => {
  assert.equal(gate({ name: 'ChatGPT', domain: 'chatgpt.com', og: 'ChatGPT helps you get answers and be more productive.', occurrence_count: 50, traffic_rank: 1 }).verdict, 'pass');
});
test('gate: PH 短 tagline 高票真工具不被误杀(回归 #1)', () => {
  assert.equal(gate({ name: 'Cursor', domain: 'cursor.com', og: 'The AI Code Editor', occurrence_count: 1200, traffic_rank: null }).verdict, 'pass');
});
test('gate: -ly 真品牌不被名字冤枉', () => {
  assert.equal(gate({ name: 'Grammarly', domain: 'grammarly.com', og: 'Grammarly makes AI writing convenient and helps you write better.', occurrence_count: 45, traffic_rank: 60 }).verdict, 'pass');
});

// ── slug 防撞 uniqueSlug(clobber 修复回归)──
test('uniqueSlug: 不撞 → 原样', () => {
  assert.equal(uniqueSlug('Granola', 'granola.ai', new Set(['cursor'])), 'granola');
});
test('uniqueSlug: 撞 → 加 domain 词根后缀', () => {
  assert.equal(uniqueSlug('Kimi', 'kimi-new.com', new Set(['kimi'])), 'kimi-kimi-new');
});
test('uniqueSlug: 再撞 → 加序号(绝不复用已有 slug)', () => {
  assert.equal(uniqueSlug('Kimi', 'kimi-new.com', new Set(['kimi', 'kimi-kimi-new'])), 'kimi-kimi-new-2');
});

// ── 域名归一 normDomain ──
test('normDomain: 去协议 / www / 路径,小写', () => {
  assert.equal(normDomain('https://www.Example.com/path?x=1'), 'example.com');
});

// ── 孤儿页清理炸站下限 orphansToPrune ──
test('orphansToPrune: 正常 → 只删孤儿', () => {
  const existing = ['a.html', 'b.html', 'old.html'];
  const keep = new Set(['a.html', 'b.html']);
  assert.deepEqual(orphansToPrune(existing, keep), ['old.html']);
});
test('orphansToPrune: keep 为空(疑似空读)→ null,绝不删', () => {
  assert.equal(orphansToPrune(['a.html', 'b.html'], new Set()), null);
});
test('orphansToPrune: 将删过半(疑似异常读)→ null,保守跳过', () => {
  const existing = ['a.html', 'b.html', 'c.html', 'd.html'];
  assert.equal(orphansToPrune(existing, new Set(['a.html'])), null); // 要删 3/4 > 半 → 跳过
});
