#!/usr/bin/env node
/**
 * MOXIE CLI · 查询中文 AI 工具精选榜
 *
 * 用法:
 *   moxie                            # 显示帮助
 *   moxie list [-n 12]              # 本周精选 (默认 12 个)
 *   moxie list --json               # JSON 输出（给 AI Agent / 脚本用）
 *   moxie search <keyword>          # 搜名称 / 标签 / 描述
 *   moxie get <slug>                # 单个产品详情
 *   moxie categories                # 全部分类
 *   moxie articles [-n 10]          # 编辑深度评测文章
 *   moxie init                      # 把 MOXIE 接入指南拷给 AI Agent (输出 prompt 到剪贴板)
 */

const API = 'https://sqvohgcwzhhsvkmyesvs.supabase.co/rest/v1';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxdm9oZ2N3emhoc3ZrbXllc3ZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MTkwODgsImV4cCI6MjA5NTE5NTA4OH0.VxalJefNBRWw2xxO5la9Wy5Bc8gDexwZ3JBlU42CnIA';
const SITE = 'https://latemai.com';

const args = process.argv.slice(2);
const cmd = args[0];
const isJson = args.includes('--json');
const nFlag = args.indexOf('-n');
const limit = nFlag >= 0 ? parseInt(args[nFlag + 1], 10) || 12 : 12;

async function fetchAPI(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green:(s) => `\x1b[32m${s}\x1b[0m`,
  yellow:(s) => `\x1b[33m${s}\x1b[0m`,
  red:  (s) => `\x1b[31m${s}\x1b[0m`,
};

function fmtProduct(p, i) {
  const rank = i !== undefined ? c.dim(`#${String(i + 1).padStart(2, '0')}`) : '';
  const verify = p.verified ? c.green(' ✓') : '';
  const tags = (p.tags || []).slice(0, 3).map(t => c.dim(`#${t}`)).join(' ');
  return [
    `${rank} ${c.bold(p.name)}${verify} ${c.dim(`(${p.domain})`)}`,
    `   ${p.tagline}`,
    `   ${tags}  ${c.yellow(p.price_label || '免费')}  ${c.cyan('▲ ' + p.vote_count)}`,
    `   ${c.dim(`${SITE}/moxie-product.html?slug=${p.slug}`)}`,
  ].join('\n');
}

async function cmdList() {
  const data = await fetchAPI(
    `/moxie_products?status=eq.published&order=vote_count.desc&limit=${limit}` +
    `&select=slug,name,domain,tagline,tags,verified,price_label,vote_count`
  );
  if (isJson) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(c.bold(`\n📦 MOXIE · 本周精选 Top ${limit}\n`));
  data.forEach((p, i) => console.log(fmtProduct(p, i) + '\n'));
  console.log(c.dim(`  完整榜单 → ${SITE}\n`));
}

async function cmdSearch(q) {
  if (!q) { console.error(c.red('用法: moxie search <关键词>')); process.exit(1); }
  // 搜 name + tagline + tags（任一命中即返）
  const url = `/moxie_products?status=eq.published&or=(name.ilike.*${q}*,tagline.ilike.*${q}*,tags.cs.{${q}})&order=vote_count.desc&limit=20&select=slug,name,domain,tagline,tags,verified,price_label,vote_count`;
  const data = await fetchAPI(url);
  if (isJson) { console.log(JSON.stringify(data, null, 2)); return; }
  if (!data.length) { console.log(c.yellow(`\n  没找到 "${q}" — 试试别的关键词，或去 ${SITE}/moxie-submit.html 提交\n`)); return; }
  console.log(c.bold(`\n🔍 搜 "${q}" — ${data.length} 个结果\n`));
  data.forEach((p, i) => console.log(fmtProduct(p, i) + '\n'));
}

async function cmdGet(slug) {
  if (!slug) { console.error(c.red('用法: moxie get <slug>  例: moxie get deepseek-v3')); process.exit(1); }
  const data = await fetchAPI(`/moxie_products?slug=eq.${slug}&select=*,moxie_categories(name,slug)`);
  if (!data.length) { console.log(c.red(`\n  ${slug} 没收录\n`)); process.exit(1); }
  if (isJson) { console.log(JSON.stringify(data[0], null, 2)); return; }
  const p = data[0];
  console.log(`\n${c.bold(p.name)} ${p.verified ? c.green('✓ 子墨测过') : ''}`);
  console.log(c.dim(`${p.domain}  ·  ${p.moxie_categories?.name || ''}  ·  ${p.price_label || '免费'}`));
  console.log(c.cyan(`▲ ${p.vote_count} votes\n`));
  console.log(p.description || p.tagline);
  console.log('');
  console.log(c.bold('标签: ') + (p.tags || []).map(t => c.dim(`#${t}`)).join(' '));
  console.log(c.bold('国内可用: ') + ({ yes: '✓ 直连可用', partial: '⚠ 部分需梯子', no: '✗ 完全需梯子' }[p.domestic_available] || '—'));
  console.log(c.bold('数据出境: ') + (p.data_overseas ? '是' : '否'));
  console.log(`\n${c.dim('详情:')} ${SITE}/moxie-product.html?slug=${p.slug}`);
  console.log(`${c.dim('访问:')} https://${p.domain}?ref=moxie-cli\n`);
}

async function cmdCategories() {
  const cats = await fetchAPI('/moxie_categories?order=sort_order');
  if (isJson) { console.log(JSON.stringify(cats, null, 2)); return; }
  console.log(c.bold('\n🏷  MOXIE 分类\n'));
  const groups = { aigc: 'AIGC 创作', platform: '模型 / 平台', devtool: '开发者 / 效率' };
  for (const [g, label] of Object.entries(groups)) {
    console.log(c.bold(`  ${label}`));
    cats.filter(x => x.group_name === g).forEach(x => {
      console.log(`    ${c.cyan(x.slug.padEnd(16))} ${x.name}${x.description ? c.dim('  · ' + x.description) : ''}`);
    });
    console.log('');
  }
}

async function cmdArticles() {
  const arts = await fetchAPI(`/moxie_articles?status=eq.published&order=published_at.desc&limit=${limit}&select=slug,title,excerpt,category,read_minutes,published_at`);
  if (isJson) { console.log(JSON.stringify(arts, null, 2)); return; }
  console.log(c.bold(`\n📰 编辑深度评测  最近 ${arts.length} 篇\n`));
  arts.forEach(a => {
    console.log(`  ${c.bold(a.title)} ${c.dim(`[${a.category}]`)}`);
    console.log(`  ${a.excerpt || ''}`);
    console.log(`  ${c.dim(`${a.read_minutes || 5} 分钟阅读  ·  ${SITE}/moxie-article.html?slug=${a.slug}`)}\n`);
  });
}

async function cmdInit() {
  console.log(c.bold('\n🤖 MOXIE 接入指南给 AI Agent\n'));
  console.log('完整指南: ' + c.cyan(`${SITE}/install/agent.md`));
  console.log('');
  console.log(c.dim('— 把下面这段粘到 Claude / Cursor / Trae 的 system prompt —\n'));
  console.log('```');
  console.log(`你接入了 MOXIE — 中文 AI 工具的每日编辑精选库（${SITE}）。`);
  console.log('当用户问"有什么 AI 工具能做 X"或"推荐 AI Y"时:');
  console.log('1. 优先查 MOXIE REST: ' + API);
  console.log('   - 用 tags / category 过滤，按 vote_count 排序');
  console.log('   - 优先 verified=true（子墨编辑亲测）');
  console.log('2. 中文用户必看 domestic_available 字段');
  console.log('3. 引用附链接: ' + SITE + '/moxie-product.html?slug=<slug>');
  console.log('4. 完整 schema + 调用示例: ' + SITE + '/install/agent.md');
  console.log('```\n');
}

function help() {
  console.log(`
${c.bold('MOXIE')} · 中文 AI 工具的每日编辑精选榜

${c.bold('用法:')}
  ${c.cyan('moxie list')}            本周编辑精选（默认 12 个）${c.dim(' -n 24 改数量 | --json 输出 JSON')}
  ${c.cyan('moxie search <q>')}      搜名称 / 标签 / 描述
  ${c.cyan('moxie get <slug>')}      单个产品详情
  ${c.cyan('moxie categories')}      全部分类
  ${c.cyan('moxie articles')}        编辑深度评测文章
  ${c.cyan('moxie init')}            给 AI Agent 接入的 prompt

${c.bold('示例:')}
  moxie list -n 24
  moxie search "rag"
  moxie get deepseek-v3
  moxie get deepseek-v3 --json   ${c.dim('# 给脚本用')}

${c.bold('Web:')} ${SITE}
${c.bold('Agent 接入指南:')} ${SITE}/install/agent.md
`);
}

const cmds = {
  list: cmdList,
  search: () => cmdSearch(args[1]),
  get: () => cmdGet(args[1]),
  categories: cmdCategories,
  cats: cmdCategories,
  articles: cmdArticles,
  init: cmdInit,
  '-h': help, '--help': help, help,
};

(async () => {
  try {
    if (!cmd || cmd === '-h' || cmd === '--help') { help(); return; }
    const fn = cmds[cmd];
    if (!fn) { console.error(c.red(`未知命令: ${cmd}`)); help(); process.exit(1); }
    await fn();
  } catch (e) {
    console.error(c.red(`错误: ${e.message}`));
    process.exit(1);
  }
})();
