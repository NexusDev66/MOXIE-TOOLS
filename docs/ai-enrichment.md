# AI 自动补全 v0（T5 MOXIE-17）

| 字段 | 值 |
|---|---|
| 任务 | MOXIE-17 (T5 6/2-6/3) |
| 入口 | admin `候选审核页` → 每条候选展开 → 「🤖 AI 一键补全」 |
| 产出 | `moxie_trend_candidates.ai_enrichment_jsonb`（5 字段 + 元数据） |
| provider | DeepSeek（默认）/ OpenAI，env `LLM_PROVIDER` 切换 |

## 流程

```
admin 点「AI 一键补全」
  → enrichCandidate(candidateId)   [server action, requireAdmin]
  → fetchProductHtml(tool_url)      拉官网 HTML（15s 超时 + 透明 UA）
  → htmlToText()                    去 script/style/标签 + 解实体 + 截断 12k 字符
  → LLM /chat/completions (json)    抽 5 字段
  → parseEnrichmentResponse()       剥代码块 + 补默认 + 类型纠正 + 截断
  → 写 ai_enrichment_jsonb + ai_enriched_at
  → 写 audit_log (source=admin_ui, endpoint=/admin/candidates/enrich)
admin 看 5 字段 → 「采纳为描述 / 技术栈采纳为标签」填进升级表单 → 升级到 moxie_products
```

**采纳是人工的**：AI 只写到 candidate 的 `ai_enrichment_jsonb`，不自动进产品库。admin 审核后手动采纳 + 升级（沿用 T3 promote 流程）。

## 5 字段

| 字段 | 含义 | 类型 | 抓不到 |
|---|---|---|---|
| `features` | 功能：做什么 + 核心卖点（中文，≤200 字） | string | 「未知」 |
| `use_cases` | 场景：适合谁、什么场景（中文，≤150 字） | string | 「未知」 |
| `pricing` | 定价：免费/订阅/价格档位（中文，≤100 字） | string | 「未知」 |
| `tech_stack` | 技术栈：技术/模型/框架（英文短词 0–8 个） | string[] | `[]` |
| `founders` | 创始人/团队（中文，≤100 字） | string | 「未知」 |

`_meta`: `{ provider, model, prompt_tokens, completion_tokens, cost_usd, source_url, truncated, enriched_at }`

## Prompt 策略

- system 钉死规则：**只依据正文不编造**、找不到填「未知」/`[]`、只输出 JSON 对象、5 字段必现、客观不夸张。
- `response_format: { type: 'json_object' }`（DeepSeek/OpenAI 都支持）+ `temperature: 0.2`（求稳定）。
- 解析端容错：剥 ` ```json ` 包裹、取首个 `{` 到末个 `}`、缺字段补默认、`tech_stack` 超 8 个截断 + 剔非字符串。完全非 JSON 才抛错。
- 完整 prompt 见 [src/lib/enrichment/prompt.ts](../src/lib/enrichment/prompt.ts) 的 `SYSTEM_PROMPT`。

## Provider 切换

env `LLM_PROVIDER`（默认 `deepseek`），只需配所选 provider 的 key：

| provider | base | model | env key |
|---|---|---|---|
| deepseek | `api.deepseek.com/chat/completions` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| openai | `api.openai.com/v1/chat/completions` | `gpt-4o-mini` | `OPENAI_API_KEY` |

两家都是 OpenAI-compatible 接口，用原生 `fetch` 直连，不引 SDK。实现见 [src/lib/enrichment/provider.ts](../src/lib/enrichment/provider.ts)。

## 成本估算

单次补全 ≈ 输入 1.5k–6k tokens（正文截到 12k 字符 ≈ ~6k tokens）+ 输出 ~200–400 tokens。

报价（USD / 1M tokens，**估算，随官方调整，以账单为准**）：

| provider | 输入 | 输出 | 单次补全估算 |
|---|---|---|---|
| deepseek-chat | $0.27 | $1.10 | ≈ $0.002–0.004 |
| gpt-4o-mini | $0.15 | $0.60 | ≈ $0.001–0.002 |

每次调用的实际 token 数 + 估算成本写在 `_meta.cost_usd`，admin 面板也会显示。按 1000 个候选全量补全一轮 ≈ $2–4（DeepSeek）。

## 测试

```bash
# 单测（mock LLM，不打真 API，零成本）
npx vitest run src/lib/enrichment/
```

覆盖：HTML 清洗/截断、prompt 组装、响应解析容错、3 个真实产品（Cursor/Notion/Linear）端到端、空正文报错。
真打 API 的本地验证：配好 `DEEPSEEK_API_KEY` 后在 admin 页面对真实候选点「AI 一键补全」。

## 不在 v0 范围

- [ ] 批量补全（现在一条一条点；后续可加「全部 pending 补全」队列）
- [ ] 自动采纳（保持人工审核闸门，不自动进产品库）
- [ ] 定价文本 → `price_label` 枚举的自动映射（现在 admin 看 AI 定价文本后手动选）
- [ ] 抓不到正文的 JS 渲染站（需 headless 浏览器，v0 跳过并报错）
