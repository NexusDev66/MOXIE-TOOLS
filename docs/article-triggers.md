# 文章生成触发器（T10 · MOXIE-23）

PRD §3.1 触发机制。两路把任务写进 `moxie_article_jobs` 队列,cron worker 消费后调 T8 `generateArticleDraft` 出**草稿**(status=draft,待 admin 在文章审核页发布)。

## 两条触发路径

| 路径 | 触发时机 | 入口 | 产出 |
|---|---|---|---|
| **事件驱动** | admin promote 候选成功后 | `enqueueCategoryRoundup`（promote action 内调用） | 某类目本周累计达阈值 → 横评(compare) |
| **定时** | 每天 09:30(北京)cron | `POST /api/internal/article-jobs/enqueue-weekly` | 本周 high-value 产品 → 选型(pick)趋势文 |

消费统一走 `POST /api/internal/article-jobs/process`（cron 每天调,drain pending）。

## ⚠️ 设计决定（待邓晖确认）：事件驱动按 products 类目统计

PRD 原文是「`trend_candidates` 同类目积累 >= N」。但 **`moxie_trend_candidates` 表没有类目列**——类目是 admin promote 之后才写到 `moxie_products.category_id`,候选阶段没有可 group by 的类目。

所以本实现把口径落在 **`moxie_products.category_id`**：某类目**本周(ISO 周)新增产品 >= N** → 入队该类目横评。理由：

1. 不改表、可逆（要改回 candidates 维度只动 `src/lib/triggers/article-enqueue.ts`）。
2. 「横评」本就针对成品工具，落在 products 上语义更顺。
3. promote 是产品进入产品库的唯一入口，「本周新增 product」≈「本周新 promote」。

> 若邓晖要求严格按 candidates，需先给 candidates 加 category 列并解决补全覆盖率问题，再切口径。

## 队列表 `moxie_article_jobs`

迁移：`supabase/migrations/20260605120000_moxie_article_jobs.sql`

| 列 | 说明 |
|---|---|
| `job_type` | `category_roundup` / `weekly_trend` |
| `status` | `pending` → `processing` → `done` / `skipped` / `failed` |
| `payload` | `{ template, product_ids, category_id?, category_slug?, reason }` |
| `dedupe_key` | **unique** 幂等键，防重复入队 |
| `result` / `last_error` / `attempts` | 处理结果 / 错误 / 重试次数 |

幂等键格式：
- 横评：`roundup:<category_slug>:<ISO周>`，如 `roundup:ai-coding:2026-W23`
- 趋势文：`weekly-trend:<ISO周>`

同一周重复触发会撞 unique（Postgres `23505`），按「本周已入队」处理，不报错。

## 阈值

`src/lib/triggers/article-enqueue.ts` 顶部常量，可调：

- `ROUNDUP_THRESHOLD = 3`：某类目本周新增产品数达到才触发横评。
- `MAX_PRODUCTS_PER_ARTICLE = 3`：一篇最多带 3 个产品（与 `buildArticleSlug` 一致）。

## worker 认领模型

`processArticleJobs`：

1. **回收卡死任务**：上次 worker 超时/崩溃会把 job 留在 `processing`。每次运行开头，把 `processing` 且 `updated_at` 超过 `STALE_MINUTES`(15min) 的回收——`attempts >= MAX_ATTEMPTS`(3) 判 `failed`(防毒任务无限烧 LLM)，其余回 `pending` 重试。
2. 取 `pending` → `update status=pending→processing` 带 `status` 条件认领（返回行才处理，防并发重复消费）。
3. 调 `generateArticleDraft` → 按结果落 `done/skipped/failed`。`skipped` 来自 T8「同 slug 已发布则不覆盖」。
4. **生成出错有界重试**:抛错 / result 非 ok(LLM 5xx、网络抖动等瞬时错误)→ 未达 `MAX_ATTEMPTS`(3) 回 `pending` 下次重试,到上限才 `failed`。数据错误(缺 payload)不重试直接 `failed`。timeout 与生成错误共用同一个 attempts 预算。

> 路由 `maxDuration=60`(兼容 Vercel Hobby),cron 一次只处理 `limit=3`。万一仍超时,卡死回收会在下次运行补上,不会永久丢任务。

## 定时部署（GitHub Actions）

`.github/workflows/article-jobs.yml`，每天 UTC 01:30（北京 09:30）：

1. `enqueue-weekly`（幂等，天天跑只产生一条本周趋势文）
2. `process`（消费 pending，含事件驱动入队的横评，最长一天延迟）

需要的配置（**不含业务 secret**，LLM key 在部署端 Next 服务）：

| 配置 | 位置 | 说明 |
|---|---|---|
| `LATEMAI_INTERNAL_TOKEN` | Actions secret | 内部 API Bearer token（同 T6） |
| `SITE_BASE_URL` | Actions variable | 线上根 URL，如 `https://latemai.com` |

## admin 看板

`/admin/article-jobs`：按时间倒序看队列、状态分布、done 的草稿链接、failed 的错误。导航在 admin 头部「文章队列」。

## 测试

- `src/lib/triggers/article-enqueue.test.ts`：ISO 周辅助(含跨年边界) + 阈值/去重/payload
- `src/lib/triggers/process-jobs.test.ts`：worker done/skipped/retry/failed/缺字段/空队列/卡死回收

## 已知边界 / 后续(v0 不修,复审 P3 留档)

- **多 worker 并发**:卡死回收的两条 update 不在同一事务;当前是「单个每日 cron worker」假设,够用。若将来上多 worker,改用 `for update skip locked` 或 rpc 包事务。
- **admin 看板无分页**:`PAGE_SIZE=80`,短期够;量大了再加按状态/光标过滤。
- **enqueue 单测的 fake sb** 不校验 `.eq/.in/.gte/.or` 滤条(只验入参与分支);若将来改 status/category_id 口径,靠集成测试在真 Supabase 兜底。
- **真打**:本地无生产 key,待部署后在 Vercel preview 验 enqueue→process 端到端 + 首条 category_roundup 草稿质量。
