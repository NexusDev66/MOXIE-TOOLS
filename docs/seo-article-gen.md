# SEO 文章自动生成 v0（T8 MOXIE-21）

| 字段 | 值 |
|---|---|
| 任务 | MOXIE-21 (T8 6/8-6/9) · PRD §3.1 |
| 入口 | server action `generateArticleFromProducts(productIds[], template)` |
| 产出 | `moxie_articles`，`status='draft'`（待 admin 审核发布） |
| LLM | 复用 T5 的 provider 抽象(DeepSeek 默认 / OpenAI，env `LLM_PROVIDER`) |

## 流程

```
admin/脚本 调 generateArticleFromProducts(productIds, template)   [server action, requireAdmin]
  → 读 moxie_products(按 id)                          [@/lib/article-gen/generate]
  → buildArticlePrompt(template, products)             [@/lib/article-gen/templates]
  → LLM chat(json)                                     [复用 createProvider]
  → parseGeneratedArticle(content) → {title,excerpt,body_html}
  → validateArticlePayload(复用 T6 校验)
  → upsertArticleBySlug(status='draft')                [复用 T6 写库]
→ admin 在审核流里查看 draft → 发布(status=published)→ T7 文章页渲染
```

**只生成 draft,不自动发布** —— 保留人工审核闸门。发布后由 T7 的 `/articles/[slug]` 渲染。

## 3 类模板（prompt 矩阵 · AC-1）

| template | 分类 | 角度 | slug 后缀 |
|---|---|---|---|
| `compare` | 横评 | 逐项对比多款工具,给"谁适合谁"结论 | `-compare` |
| `pick` | 选型 | 按人群/预算/场景给决策建议 | `-pick` |
| `guide` | 手册 | 上手 how-to、工作流、避坑 | `-guide` |

每个模板都要求 LLM:
- **长尾关键词**:由产品名 + 模板意图派生种子词(如「Cursor vs Copilot 对比」「X 怎么选」「X 怎么用」),自然嵌入标题/小标题/首段,不堆砌。
- **结构**:正文用 `<h2>/<h3>` 分节(H1=标题单列),段落 `<p>`。
- **schema-friendly**:结尾带「常见问题」H2 + 2-3 组 `<h3>问/<p>答`,利于 FAQ 结构化抓取。
- 输出干净 HTML 片段(只 h2/h3/p/ul/li/strong),JSON 包 `{title, excerpt, body_html}`。

完整 prompt 见 [templates.ts](../src/lib/article-gen/templates.ts) 的 `SYSTEM_PROMPT`。

## 落库字段映射

| moxie_articles | 来源 |
|---|---|
| `slug` | 产品 slug(≤3 个)+ 模板后缀,清洗为 `[a-z0-9-]` |
| `title` / `excerpt` / `body_html` | LLM 输出 |
| `category` | 模板中文名(横评/选型/手册) |
| `read_minutes` | 正文字数 ÷ 400 估算 |
| `status` | **`draft`** |
| `related_product_ids` | 入参 productIds |

> 注:`moxie_articles` 无 tags 列,故关键词只嵌进正文(符合 AC-1 SEO 诉求),来源产品记在 `related_product_ids`。

## ENV

复用 T5 配置,无新增:`LLM_PROVIDER`(默认 deepseek)、`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`。

## 成本（估算）

单篇长文 ≈ 输入 ~1k tokens + 输出 ~1.5-2k tokens。DeepSeek ≈ ¥0.02-0.04/篇,gpt-4o-mini ≈ ¥0.01-0.02/篇。实际 token/成本在生成结果 `meta` 里返回。

## 测试

```bash
npx vitest run src/lib/article-gen/
```

12 项([generate.test.ts](../src/lib/article-gen/generate.test.ts)):prompt 组装(含长尾词/结构/3 模板角度)、解析容错(裸 JSON / ```json / 缺字段 / 非 JSON)、slug 生成、3 模板端到端产 draft(mock LLM+DB)、空入参 / 产品查不到的报错。

## 不在 v0 范围

- 真实 LLM 调用验证(单测是 mock;真打需配 `DEEPSEEK_API_KEY`,同 T5)
- admin 触发 UI(AC 未要求;server action 已就绪,供后续页面/脚本调用)
- 自动发布(保留人工审核)/ 自动配图(cover 留空,发布前人工补或接 T6 图片闭环)
- 生成去重(同 slug 再次生成会走 T6 的 UPDATE 覆盖事实字段)
