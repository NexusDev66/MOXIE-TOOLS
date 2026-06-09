#!/usr/bin/env node
/**
 * Phase 3 · 国产新锐发现(curated 清单)
 *
 * 国产侧没有 PH 那种带 API+干净域名的源,自动抓极易抓到灰产(v1 教训)。
 * 折中:维护一份人工甄选的国产新锐清单(name+domain,确信真实)→ DeepSeek 补全中文字段
 * → 去重 → 入 moxie_products status=pending。人工 QA 后 promote。质量优先、可控。
 *
 * 跑法:node --env-file=.env.local cli/discover-domestic.js [--dry-run]
 * 需 env:NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、DEEPSEEK_API_KEY。
 * 新增国产新锐:往下面 SEEDS 加 {name, domain} 即可。
 */

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

const CATEGORY_SLUGS = ['llm', 'ai-assistant', 'ai-writing', 'ai-image', 'ai-video', 'ai-coding', 'ai-search', 'rag', 'agent', 'workflow'];

// 人工甄选的国产新锐(确信真实,未收录)。要扩源往这加。
// slug 必填(中文名 slugify 会变垃圾,故显式给英文 slug)。
const SEEDS = [
  { name: '跃问', domain: 'yuewen.cn', slug: 'yuewen' },              // 阶跃星辰
  { name: '讯飞星火', domain: 'xinghuo.xfyun.cn', slug: 'xinghuo' },  // 科大讯飞
  { name: '百川大模型', domain: 'baichuan-ai.com', slug: 'baichuan' },// 百川智能
  { name: '商量 SenseChat', domain: 'chat.sensetime.com', slug: 'sensechat' }, // 商汤
  { name: '纳米AI搜索', domain: 'n.cn', slug: 'nami-ai' },            // 360
  { name: '通义听悟', domain: 'tingwu.aliyun.com', slug: 'tingwu' },  // 阿里
  { name: 'WHEE', domain: 'whee.com', slug: 'whee' },                 // 美图
  { name: 'Lovart', domain: 'lovart.ai', slug: 'lovart' },           // AI 设计 agent
  { name: '知乎直答', domain: 'zhida.zhihu.com', slug: 'zhida' },     // 知乎
  { name: 'Monica', domain: 'monica.im', slug: 'monica' },           // 国产出海 AI 助手
  { name: '沉浸式翻译', domain: 'immersivetranslate.com', slug: 'immersive-translate' },
  { name: '讯飞智文', domain: 'zhiwen.xfyun.cn', slug: 'zhiwen' },    // 科大讯飞 AI PPT

  // ── 主流补录(国产+海外,确信真实、未收录;data_overseas 自动按 domestic_available 判定)──
  { name: 'Llama', domain: 'llama.com', slug: 'llama' },                       // Meta 开源大模型
  { name: '腾讯混元', domain: 'hunyuan.tencent.com', slug: 'hunyuan' },        // 腾讯大模型
  { name: 'Apple Intelligence', domain: 'apple.com', slug: 'apple-intelligence' },
  { name: 'Microsoft Copilot', domain: 'copilot.microsoft.com', slug: 'ms-copilot' },
  { name: 'Jasper', domain: 'jasper.ai', slug: 'jasper' },                     // 营销文案
  { name: 'Copy.ai', domain: 'copy.ai', slug: 'copy-ai' },
  { name: 'Stable Diffusion', domain: 'stability.ai', slug: 'stable-diffusion' },
  { name: 'Adobe Firefly', domain: 'firefly.adobe.com', slug: 'firefly' },
  { name: 'Sora', domain: 'sora.com', slug: 'sora' },                          // OpenAI 视频
  { name: 'Google Veo', domain: 'deepmind.google', slug: 'veo' },              // Google 视频
  { name: 'LlamaIndex', domain: 'llamaindex.ai', slug: 'llamaindex' },
  { name: 'LangChain', domain: 'langchain.com', slug: 'langchain' },
  { name: '阿里云百炼', domain: 'bailian.console.aliyun.com', slug: 'bailian' },// 模型/Agent 平台

  // ── 第二批补录(2026-06-09)──
  { name: 'Grok', domain: 'grok.com', slug: 'grok' },                          // xAI
  { name: 'Mistral AI', domain: 'mistral.ai', slug: 'mistral' },
  { name: 'Hugging Face', domain: 'huggingface.co', slug: 'huggingface' },
  { name: 'Poe', domain: 'poe.com', slug: 'poe' },
  { name: 'Character.AI', domain: 'character.ai', slug: 'character-ai' },
  { name: 'Replit', domain: 'replit.com', slug: 'replit' },                    // AI 编程
  { name: 'Lovable', domain: 'lovable.dev', slug: 'lovable' },
  { name: 'Synthesia', domain: 'synthesia.io', slug: 'synthesia' },            // AI 数字人视频
  { name: 'Luma Dream Machine', domain: 'lumalabs.ai', slug: 'luma' },
  { name: 'ElevenLabs', domain: 'elevenlabs.io', slug: 'elevenlabs' },         // AI 语音
  { name: 'DeepL', domain: 'deepl.com', slug: 'deepl' },                       // AI 翻译
  { name: 'Otter.ai', domain: 'otter.ai', slug: 'otter' },                     // 会议转写
  { name: '火山方舟', domain: 'volcengine.com', slug: 'volcengine' },          // 字节大模型平台
  { name: '零一万物', domain: '01.ai', slug: 'lingyiwanwu' },                  // Yi 大模型
  { name: 'WPS AI', domain: 'wps.cn', slug: 'wps-ai' },
  { name: '讯飞听见', domain: 'iflyrec.com', slug: 'iflyrec' },                // 转写

  // ── 第三批补录(2026-06-09)──
  { name: 'Cohere', domain: 'cohere.com', slug: 'cohere' },
  { name: 'Together AI', domain: 'together.ai', slug: 'together-ai' },
  { name: 'Groq', domain: 'groq.com', slug: 'groq' },                          // 极速推理
  { name: 'Pi', domain: 'pi.ai', slug: 'pi' },                                 // Inflection
  { name: 'Meta AI', domain: 'meta.ai', slug: 'meta-ai' },
  { name: 'QuillBot', domain: 'quillbot.com', slug: 'quillbot' },             // 改写/润色
  { name: 'Leonardo.Ai', domain: 'leonardo.ai', slug: 'leonardo' },
  { name: 'Recraft', domain: 'recraft.ai', slug: 'recraft' },
  { name: 'Krea', domain: 'krea.ai', slug: 'krea' },
  { name: 'Descript', domain: 'descript.com', slug: 'descript' },             // 音视频编辑
  { name: 'CapCut', domain: 'capcut.com', slug: 'capcut' },                   // 剪辑(海外剪映)
  { name: 'Aider', domain: 'aider.chat', slug: 'aider' },                     // 终端 AI 编程
  { name: 'Tabnine', domain: 'tabnine.com', slug: 'tabnine' },
  { name: 'Phind', domain: 'phind.com', slug: 'phind' },                      // 开发者搜索
  { name: 'Pinecone', domain: 'pinecone.io', slug: 'pinecone' },             // 向量数据库
  { name: 'CrewAI', domain: 'crewai.com', slug: 'crewai' },                   // 多智能体框架
  { name: 'Flowise', domain: 'flowiseai.com', slug: 'flowise' },             // 可视化 LLM 工作流
  { name: '文心一格', domain: 'yige.baidu.com', slug: 'yige' },               // 百度 AI 绘画
  { name: '稿定设计', domain: 'gaoding.com', slug: 'gaoding' },               // AI 设计
  { name: 'AiPPT', domain: 'aippt.cn', slug: 'aippt' },                       // AI 生成 PPT
];

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!DEEPSEEK_API_KEY) { console.error('❌ 缺 DEEPSEEK_API_KEY'); process.exit(1); }

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'tool'; }

const ENRICH_SYS = `你是国产 AI 工具库编辑。给你一个国产 AI 工具的名称和官网,凭你确知的信息产出中文入库字段。要求:
1. 只依据你确知的事实,不确定就给保守值,绝不编造功能。
2. 价格红线:绝不编造具体金额,price_label 只能用枚举:免费 / 免费+付费 / 订阅 / 付费 / 不详。
3. category_slug 必须从这 10 个里选最贴切的一个:llm, ai-assistant, ai-writing, ai-image, ai-video, ai-coding, ai-search, rag, agent, workflow。
只输出 JSON,字段:
  tagline_zh: 一句话中文卖点,≤ 30 字
  description_zh: 2-3 句中文简介
  category_slug: 上述 10 选 1
  tags: 2-4 个中文短标签数组
  price_label: 上述枚举之一
  domestic_available: 国内可用性,枚举:是 / 否 / 需代理 / 不详(国产工具一般"是")
不要输出 JSON 以外内容。`;

async function enrich(item) {
  const user = `名称:${item.name}\n官网:${item.domain}\n按系统要求输出 JSON。`;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: ENRICH_SYS }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.3, max_tokens: 600 }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const j = await res.json();
  let s = (j.choices?.[0]?.message?.content || '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  return {
    tagline_zh: (o.tagline_zh || '').toString().slice(0, 30),
    description_zh: (o.description_zh || '').toString().slice(0, 500),
    category_slug: CATEGORY_SLUGS.includes(o.category_slug) ? o.category_slug : null,
    tags: Array.isArray(o.tags) ? o.tags.slice(0, 4).map((t) => String(t).slice(0, 12)) : [],
    price_label: ['免费', '免费+付费', '订阅', '付费', '不详'].includes(o.price_label) ? o.price_label : '不详',
    domestic_available: ['是', '否', '需代理', '不详'].includes(o.domestic_available) ? o.domestic_available : '是',
  };
}

async function main() {
  console.log(`\n🇨🇳 国产新锐发现${DRY_RUN ? ' [DRY-RUN]' : ''} · ${SEEDS.length} 个候选\n`);
  const existing = await sb('/moxie_products?select=domain,slug&limit=2000');
  const known = new Set(existing.map((p) => (p.domain || '').toLowerCase().replace(/^www\./, '')));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const cats = await sb('/moxie_categories?select=id,slug');
  const catId = Object.fromEntries(cats.map((c) => [c.slug, c.id]));

  const tally = { ok: 0, dup: 0, badcat: 0, fail: 0 };
  for (const it of SEEDS) {
    const domain = it.domain.toLowerCase().replace(/^www\./, '');
    if (known.has(domain)) { console.log(`  · ${it.name} (${domain}) → 已收录,跳过`); tally.dup++; continue; }
    try {
      const e = await enrich(it);
      if (!e.category_slug || !catId[e.category_slug]) { console.log(`  · ${it.name} → 难归类,跳过`); tally.badcat++; continue; }
      let slug = it.slug || slugify(it.name); if (knownSlug.has(slug)) slug = slug + '-' + domain.split('.')[0];
      const row = {
        slug, name: it.name, domain,
        tagline: e.tagline_zh, description: e.description_zh,
        category_id: catId[e.category_slug], tags: e.tags,
        price_label: e.price_label, domestic_available: e.domestic_available,
        data_overseas: e.domestic_available !== '是', verified: false, featured: false, vote_count: 0, status: 'pending',
      };
      if (DRY_RUN) { console.log(`  ✓[dry] ${it.name} (${domain}) [${e.category_slug}] ${e.tagline_zh} | ${e.price_label}/${e.domestic_available}`); tally.ok++; continue; }
      known.add(domain); knownSlug.add(slug);
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: [row] });
      console.log(`  ✓ ${it.name} (${domain}) [${e.category_slug}] → pending`);
      tally.ok++;
    } catch (err) { console.log(`  · ${it.name} → 补全失败(${err.message}),跳过`); tally.fail++; }
  }
  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 status=pending。人工 QA 后 promote。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
