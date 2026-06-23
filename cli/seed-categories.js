#!/usr/bin/env node
/**
 * 扩充分类体系(10 → 16)。幂等:已存在的 slug 跳过(on_conflict=slug)。
 * 分类器(ai-clean)动态读 moxie_categories,加完即生效;前端 mega-menu/分类页也动态渲染。
 * 跑法:node --env-file=.env.local cli/seed-categories.js [--dry-run]
 */
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DRY = process.argv.includes('--dry-run');
if (!SUPABASE_URL || !KEY) { console.error('❌ 缺 SUPABASE 配置'); process.exit(1); }

// 新增分类(group_name 复用 aigc/platform/devtool,新增 biz=商业/行业)
const NEW = [
  { slug: 'ai-audio', name: 'AI 音频 / 语音', group_name: 'aigc', sort_order: 11, description: '语音合成 / 配音 / 音乐 / 音频处理' },
  { slug: 'ai-design', name: 'AI 设计', group_name: 'aigc', sort_order: 12, description: '平面 / 海报 / Logo / 演示 / 品牌设计' },
  { slug: 'ai-office', name: 'AI 办公 / 生产力', group_name: 'devtool', sort_order: 13, description: '文档 / 会议 / 笔记 / PPT / 效率' },
  { slug: 'ai-data', name: '数据分析', group_name: 'devtool', sort_order: 14, description: '数据分析 / BI / 表格 / 爬取' },
  { slug: 'ai-marketing', name: 'AI 营销', group_name: 'biz', sort_order: 15, description: '营销 / 增长 / 广告 / 社媒 / SEO' },
  { slug: 'ai-support', name: 'AI 客服', group_name: 'biz', sort_order: 16, description: '客服 / SDR / 销售 / 对话机器人' },
];

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}

async function main() {
  const existing = await sb('/moxie_categories?select=slug');
  const have = new Set(existing.map((c) => c.slug));
  const todo = NEW.filter((c) => !have.has(c.slug));
  console.log(`\n现有 ${existing.length} 个分类,新增 ${todo.length} 个:${todo.map((c) => c.name).join('、') || '(无)'}\n`);
  if (!todo.length) return;
  if (DRY) { todo.forEach((c) => console.log(`  [dry] + ${c.group_name} / ${c.slug}(${c.name})`)); return; }
  const r = await sb('/moxie_categories?on_conflict=slug', { method: 'POST', prefer: 'return=representation,resolution=ignore-duplicates', body: todo });
  console.log(`✓ 已插入 ${(r || []).length} 个分类`);
  (r || []).forEach((c) => console.log(`  + #${c.id} ${c.group_name} / ${c.slug}(${c.name})`));
}
main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
