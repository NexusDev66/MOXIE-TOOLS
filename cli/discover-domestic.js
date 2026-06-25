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
import { screen } from './screen.mjs';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');


// 人工甄选的国产新锐(确信真实,未收录)。要扩源往这加。
// slug 必填(中文名 slugify 会变垃圾,故显式给英文 slug)。
const SEEDS = [
  { name: '魔搭社区', domain: 'modelscope.cn', slug: 'modelscope' },   // 阿里达摩院 模型开源社区
  { name: '书生·浦语 InternLM', domain: 'internlm.org', slug: 'internlm' }, // 上海 AI 实验室 开源大模型
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

  // ── 第四批补录(2026-06-09)──
  { name: 'You.com', domain: 'you.com', slug: 'you-com' },                    // AI 搜索
  { name: 'Elicit', domain: 'elicit.com', slug: 'elicit' },                   // 科研搜索
  { name: 'Consensus', domain: 'consensus.app', slug: 'consensus' },          // 论文搜索
  { name: 'Glean', domain: 'glean.com', slug: 'glean' },                      // 企业搜索
  { name: 'Cline', domain: 'cline.bot', slug: 'cline' },                      // AI 编程
  { name: 'Continue', domain: 'continue.dev', slug: 'continue' },
  { name: 'Sourcegraph Cody', domain: 'sourcegraph.com', slug: 'cody' },
  { name: 'Reka AI', domain: 'reka.ai', slug: 'reka' },                       // 多模态大模型
  { name: 'AI21 Labs', domain: 'ai21.com', slug: 'ai21' },
  { name: 'Photoroom', domain: 'photoroom.com', slug: 'photoroom' },          // AI 抠图/电商图
  { name: 'Napkin AI', domain: 'napkin.ai', slug: 'napkin' },                 // 文字转图示
  { name: 'Beautiful.ai', domain: 'beautiful.ai', slug: 'beautiful-ai' },     // AI PPT
  { name: '网易有道', domain: 'youdao.com', slug: 'youdao' },                 // 翻译/AI

  // ── 第五批补录(2026-06-25):主流国产 AI 产品(人工确认真实官网,均国内直连)──
  { name: '豆包', domain: 'doubao.com', slug: 'doubao' },                      // 字节 AI 助手
  { name: '通义', domain: 'tongyi.com', slug: 'tongyi' },                      // 阿里通义
  { name: '文心一言', domain: 'yiyan.baidu.com', slug: 'wenxinyiyan' },        // 百度
  { name: '讯飞星火', domain: 'xinghuo.xfyun.cn', slug: 'xinghuo' },           // 科大讯飞
  { name: '可灵 AI', domain: 'klingai.com', slug: 'kling' },                   // 快手 AI 视频
  { name: '秘塔 AI 搜索', domain: 'metaso.cn', slug: 'metaso' },               // AI 搜索
  { name: '腾讯元宝', domain: 'yuanbao.tencent.com', slug: 'yuanbao' },        // 腾讯 AI 助手
  { name: '海螺 AI', domain: 'hailuoai.com', slug: 'hailuo' },                 // MiniMax
  { name: '天工 AI', domain: 'tiangong.cn', slug: 'tiangong' },                // 昆仑万维
  { name: '百川智能', domain: 'baichuan-ai.com', slug: 'baichuan' },           // 大模型
  { name: 'DeepSeek', domain: 'deepseek.com', slug: 'deepseek' },              // 深度求索
  { name: '跃问', domain: 'yuewen.cn', slug: 'yuewen' },                       // 阶跃星辰
  { name: '知乎直答', domain: 'zhida.zhihu.com', slug: 'zhida' },              // 知乎 AI 搜索
  { name: '智谱 BigModel', domain: 'bigmodel.cn', slug: 'bigmodel' },          // 智谱开放平台
  { name: 'WHEE', domain: 'whee.com', slug: 'whee' },                          // 美图 AI 图像
  { name: '剪映', domain: 'jianying.com', slug: 'jianying' },                  // 字节 AI 剪辑
  { name: '通义听悟', domain: 'tingwu.aliyun.com', slug: 'tingwu' },           // 阿里 会议转写
  { name: '硅基流动', domain: 'siliconflow.cn', slug: 'siliconflow' },         // 大模型推理云
  { name: '面壁智能', domain: 'modelbest.cn', slug: 'modelbest' },             // MiniCPM
  { name: '腾讯元器', domain: 'yuanqi.tencent.com', slug: 'yuanqi' },          // 腾讯智能体平台
  { name: '美图设计室', domain: 'x-design.com', slug: 'x-design' },            // 美图 AI 设计
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

// 归一/判定走统一 screen(规则闸→AI层)。curated 种子用 skipGate(见下),消掉这里原有的第二份 enrich。

async function main() {
  console.log(`\n🇨🇳 国产新锐发现${DRY_RUN ? ' [DRY-RUN]' : ''} · ${SEEDS.length} 个候选\n`);
  const existing = await sb('/moxie_products?select=domain,slug&limit=2000');
  const known = new Set(existing.map((p) => (p.domain || '').toLowerCase().replace(/^www\./, '')));
  const knownSlug = new Set(existing.map((p) => p.slug));
  const catRows = await sb('/moxie_categories?select=id,slug,name');
  const catId = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));
  const cats = catRows.map((c) => ({ slug: c.slug, name: c.name }));  // 给 screen/aiClean

  const tally = { ok: 0, dup: 0, reject: 0, badcat: 0, fail: 0 };
  for (const it of SEEDS) {
    const domain = it.domain.toLowerCase().replace(/^www\./, '');
    if (known.has(domain)) { console.log(`  · ${it.name} (${domain}) → 已收录,跳过`); tally.dup++; continue; }
    try {
      // curated 种子人工已确信 → skipGate 跳过反灰产闸(种子无 og/信号会被误拒),仍走 AI 归一+兜底判定
      const r = await screen({ name: it.name, domain, og: '' }, cats, { trusted: true });
      if (r.verdict !== 'keep') { console.log(`  ✗ ${it.name} → AI 判 ${r.kind}:${r.reason}`); tally.reject++; continue; }
      const e = r.normalized;
      if (!e.category_slug || !catId[e.category_slug]) { console.log(`  · ${it.name} → 难归类,跳过`); tally.badcat++; continue; }
      // slug 防撞:种子优先用显式 slug;撞了循环加后缀保唯一(绝不复用已有 slug)
      let slug = it.slug || slugify(it.name);
      if (knownSlug.has(slug)) { const base = `${slug}-${domain.split('.')[0]}`; slug = base; for (let i = 2; knownSlug.has(slug); i++) slug = `${base}-${i}`; }
      const row = {
        slug, name: it.name, domain,
        tagline: e.tagline_zh, description: e.description_zh,
        category_id: catId[e.category_slug], tags: e.tags,
        price_label: e.price_label, domestic_available: e.domestic_available,
        data_overseas: e.domestic_available !== '是', verified: false, featured: false, vote_count: 0, status: 'pending',
      };
      if (DRY_RUN) { console.log(`  ✓[dry] ${it.name} (${domain}) [${e.category_slug}] ${e.tagline_zh} | ${e.price_label}/${e.domestic_available}`); tally.ok++; continue; }
      known.add(domain); knownSlug.add(slug);
      await sb('/moxie_products?on_conflict=slug', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [row] });
      console.log(`  ✓ ${it.name} (${domain}) [${e.category_slug}] → pending`);
      tally.ok++;
    } catch (err) { console.log(`  · ${it.name} → 处理失败(${err.message}),跳过`); tally.fail++; }
  }
  console.log(`\n汇总:入库 ${tally.ok} · 已收录 ${tally.dup} · AI拒 ${tally.reject} · 难归类 ${tally.badcat} · 失败 ${tally.fail}`);
  if (tally.ok && !DRY_RUN) console.log(`已写 ${tally.ok} 条 status=pending。人工 QA 后 promote。`);
}

main().catch((e) => { console.error('❌ 失败:', e.message); process.exit(1); });
