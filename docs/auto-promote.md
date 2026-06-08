# 候选完善度阈值 → 自动 promote（T11 · MOXIE-24）

trend candidate 数据攒够了(完善度分 ≥ 阈值)就**自动升级**到 `moxie_products`,省掉人工逐条点。仍**保留人工 promote 兜底**。

## 完善度打分 `lib/scoring/completeness.ts`

`scoreCandidate(candidate)` 返回 0–100 分 + 各维度 breakdown + missing 列表。纯函数,可单测。

| 维度 | 权重 | 说明 |
|---|---|---|
| 有产品名 `tool_name_hint` | 15 | upsert 的 name 必填 |
| 跨站频次 `occurrence_count` | 15 | 线性封顶 3 个源,多源 = 更可信 |
| AI `features`(功能) | 20 | 派生 tagline/description 主来源 |
| AI `use_cases`(场景) | 15 | |
| AI `pricing`(定价,非「未知」) | 10 | |
| AI `founders`(创始人,非「未知」) | 5 | |
| AI `tech_stack`(技术栈,非空) | 5 | |
| 已截图 `screenshot_url` | 15 | |

「未知」占位符 / 空数组**不计分**。

## 阈值 `CANDIDATE_AUTO_PROMOTE_THRESHOLD`

env(0–100,默认 **70**)。`autoPromoteThreshold()` 读取,非法值回默认。70 分天然要求「有名 + AI 补全核心字段」,正好够拼合法 product payload。

## 自动 promote `lib/candidates/auto-promote.ts`

`autoPromoteCandidates()`:扫 `status=pending` 候选 → `scoreCandidate` → 分 ≥ 阈值 → `buildAutoPromotePayload` 派生 payload → **`validateProductPayload` 兜底闸门** → `executePromote`。

payload 派生(candidate + ai_enrichment):
- `slug` = 域名/名字 slugify(对齐 promote-form 的 `suggestSlug`)
- `name` = `tool_name_hint` 退 domain
- `tagline` = features 第一句截 30 字(退用 name)
- `description` = features + use_cases
- `price_label` = pricing(截 30)
- `tags` = tech_stack 里 ≤8 字符的短词
- **类目留空**:ai_enrichment 无 category;自动升级的产品 `category_id` 为空,admin 后续可补(也因此不触发 T10 的同类目横评,需 admin 补类目后才有)

> 任何派生不合法(无 domain、payload 校验不过)→ skip 该候选,不升级,不影响其余。

**⚠️ domain 已存在则只链接、不覆盖(复审 #13)**:自动升级走 `onExistingDomain='link'`。若候选 domain 已在 `moxie_products`(比如人工维护好类目+内容的产品),**不**走 upsert 的 UPDATE 路径(那会清零 category_id、用 AI 派生内容覆盖人工内容),而是只把候选标 `promoted` + 链接到现有产品;domain 不存在才 INSERT 新建。人工 promote(admin 填了表单)仍走 `'update'` 覆盖,属有意为之。

## promote 核心 `lib/candidates/promote-core.ts`

`executePromote(sb, { candidateId, payload, categoryMap? })` —— **人工(admin action)与自动(cron)共用同一条升级路**:分类校验 → upsert 产品 → 带入封面(T9)→ candidate 标 promoted → 入队同类目横评(T10)。不做 auth/audit(调用方处理)。

从 `admin/(authed)/candidates/actions.ts` 抽出,避免两条路逻辑分叉。

## cron 部署 `.github/workflows/candidate-auto-promote.yml`

每天 UTC 01:00(北京 09:00)curl `POST /api/internal/candidates/auto-promote`(Bearer)。配置同 T10:`secrets.LATEMAI_INTERNAL_TOKEN` + `vars.SITE_BASE_URL`。

## admin 看板（AC-4 / AC-5）

`/admin/candidates` 每条候选显示**完善度分徽标**(达阈值绿、否则黄)+ **「再次校验」按钮**(`recheckCandidate`:重算分,达阈值即自动升级该条,不必等 cron)。**人工 promote 表单原样保留**作兜底。

## 测试

- `src/lib/scoring/completeness.test.ts`:打分 / 满分 / 「未知」不计 / occurrence 封顶
- `src/lib/candidates/auto-promote.test.ts`:payload 派生 / 阈值门控 / 派生失败 skip / env 阈值

## 已知边界（v0）

- 自动升级产品**无类目**(enrichment 无 category),需 admin 后补;补前不触发 T10 同类目横评。
- 不同 domain 派生出相同 slug 时,upsert 撞 slug unique → 该条 failed(candidate 留 pending),admin 可人工换 slug 升级。
- cron 单 worker 串行;量大时一次 limit 默认 30,余下下次。扫描按「有 AI 补全优先(ai_enriched_at 非空在前)→ 跨站频次」排序,避免无补全的高频候选占满窗口、把够格的挤出去。
