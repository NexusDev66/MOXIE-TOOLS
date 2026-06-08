# `POST /api/internal/articles` — 入库 API（articles）

| 字段 | 值 |
|---|---|
| 任务 | MOXIE-18 (T6 6/4) |
| 路径 | `POST /api/internal/articles` |
| 认证 | `Authorization: Bearer <LATEMAI_INTERNAL_TOKEN>`（与 products 同一 token） |
| 幂等键 | `slug`（按 slug 分 INSERT/UPDATE 两路径） |
| 发布闭环 | `cover_url` + `body_html` 内图自动 fetch → 传 `moxie-covers` Storage → 替换为公网链接 |
| 审计 | 每次请求落 `moxie_audit_logs` 一行（`target_type='article'`） |

复用 T2 的 `src/lib/sync/{auth,errors,audit}` —— Bearer 校验、错误码、审计完全一致，下文只列差异。

## Request Body (JSON)

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `slug` | string | ✅ | `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`，≤ 80，**幂等键** |
| `title` | string | ✅ | ≤ 120 |
| `excerpt` | string | ❌ | ≤ 300 |
| `body_html` | string | ❌ | ≤ 100000，富文本 HTML（内 `<img>` 会被 import） |
| `cover_url` | string | ❌ | http(s) URL，≤ 500（会被 import 到 Storage） |
| `category` | string | ❌ | ≤ 20（横评/手册/增长/选型，自由文本，默认 `横评`） |
| `read_minutes` | int | ❌ | 1–120（默认 5） |
| `status` | `draft` \| `published` | ❌ | 默认 `published` |
| `published_at` | string(ISO) | ❌ | 不填且 `published` → 服务端 `now()` |
| `related_product_ids` | number[] | ❌ | 正整数，≤ 50 |
| `source` | object | ❌ | 溯源元数据（落 audit_log） |

## 幂等语义 · 新建 vs re-sync

按 `slug` 分两路径，写入字段集不同（同 T2 products 的设计）：

| 场景 | 行为 | 写入字段 |
|---|---|---|
| **新 slug（INSERT）** | 写全量行 | 事实字段 + `status`（默认 published）+ `published_at` |
| **同 slug（re-sync UPDATE）** | **只刷事实字段** | `title` / `excerpt` / `body_html` / `cover_url` / `category` / `read_minutes` / `related_product_ids` |

re-sync **绝不触碰**：`status`（admin 可能已 draft↔published 调过）、`published_at`（首次发布时间）、`author_id`（人工指派）。
> moxie_articles 无 `updated_at` 列，故 UPDATE 不写它。

## 图片 import（AC-4）

`cover_url` + `body_html` 内所有 `<img src>` 里的**外部 http(s) 图片**：

1. **SSRF 检查**：拒 localhost / `*.local` / `*.internal` / 私网 IP（含域名 DNS 解析后判私网，挡 `169.254.169.254` 云元数据等）→ 不安全则跳过
2. fetch（**8s 超时**，**并发 5**，**重定向手动跟随、每跳重校验目标 host**——封「公网 302 跳内网」绕过，最多 3 跳）→ 校验 `content-type` 在 raster 白名单（png/jpg/webp/gif/avif，**不收 SVG**——防存储型 XSS）且 ≤ 5MB
3. 传到 Storage bucket `moxie-covers`，路径 `articles/<slug>/<sha256(url)前16>.<ext>`（`upsert`）
4. 把 `body_html` / `cover_url` 里的原链接替换成 Storage 公网 URL（按 URL 长度降序替换，避免子串串扰）

稳妥约束：
- 整篇最多 import **20** 张；超额 / 已在我们 Storage 上的 / SSRF 不安全 → 跳过（计 `skipped`）
- **任何单图失败都不阻断入库**：保留原链接，计入 `failed`
- route 导出 `maxDuration = 60`（并发5 + 单图8s + 上限20，最坏约 ≤40s，留足余量）

响应 `data.images` 给出 `{ imported, failed, skipped }` 统计。

## Response

`201 Created`（新 slug）/ `200 OK`（同 slug）：

```json
{
  "ok": true,
  "request_id": "9f3c8a02-...",
  "data": {
    "id": 42,
    "slug": "cursor-vs-copilot",
    "status": "published",
    "inserted": true,
    "images": { "imported": 2, "failed": 0, "skipped": 0 }
  }
}
```

错误 body / 错误码同 products（见 [internal-products.md](./internal-products.md)）：
`400 INVALID_PAYLOAD` / `400 SLUG_FORMAT` / `401 MISSING_TOKEN` / `403 INVALID_TOKEN` / `405 METHOD_NOT_ALLOWED` / `500 INTERNAL_ERROR`。

## AC-5 手工 curl 实测

> 前置：`.env.local` 配 `LATEMAI_INTERNAL_TOKEN` / `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`；Supabase 已建 `moxie-covers` bucket（public）。

### 1. 新建（含图片 import）

```bash
export TOKEN="<你配的 LATEMAI_INTERNAL_TOKEN>"
export BASE="http://localhost:3000"

curl -sS -X POST "$BASE/api/internal/articles" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: ac5-art-001" \
  -d '{
    "slug": "ac5-test-article",
    "title": "AC5 测试文章",
    "excerpt": "T6 验收用",
    "category": "横评",
    "read_minutes": 6,
    "cover_url": "https://picsum.photos/800/400",
    "body_html": "<p>正文</p><img src=\"https://picsum.photos/600/300\" alt=\"demo\">"
  }' | jq
```

期望：`201`，`data.inserted=true`，`data.images.imported=2`，且去 Supabase Storage `moxie-covers/articles/ac5-test-article/` 下能看到 2 张图。

### 2. 重复 update（同 slug）

```bash
curl -sS -X POST "$BASE/api/internal/articles" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: ac5-art-002" \
  -d '{ "slug": "ac5-test-article", "title": "改了标题" }' | jq
```

期望：`200`，`data.inserted=false`，`id` 与上一步相同；DB 里 `status` / `published_at` 未被改。

### 3. 校验失败

```bash
# 缺 token → 401
curl -sS -X POST "$BASE/api/internal/articles" -H "Content-Type: application/json" -d '{}' -w "\n%{http_code}\n"
# 缺 slug → 400 field=slug
curl -sS -X POST "$BASE/api/internal/articles" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"title":"no slug"}' -w "\n%{http_code}\n"
# 非 POST → 405
curl -sS -X GET "$BASE/api/internal/articles" -w "\n%{http_code}\n"
```

### 4. 清理

```sql
delete from moxie_articles where slug = 'ac5-test-article';
delete from moxie_audit_logs where request_id like 'ac5-art-%';
-- Storage: 手动删 moxie-covers/articles/ac5-test-article/
```

## 单测

```bash
npm run test    # 或 npx vitest run src/app/api/internal/articles/
```

8 个情形（[route.test.ts](../../src/app/api/internal/articles/route.test.ts)）：缺 token / 缺 slug / 新 slug 201 / 同 slug 200 / 图片 import 链接替换 / 图片失败不阻断 / SSRF 私网跳过 / SVG 拒收。

## 已知限制 / 不在 T6 范围

- [ ] body_html 富文本消毒（XSS）—— 当前信任内部 worker 来源，后续若开放渲染需加 sanitize
- [ ] 无 `content-length` 的图会先读完整 buffer 再判大小（极端超大图有内存峰值；已有 8s 超时兜底）
- [ ] re-sync（同 slug UPDATE）会用 payload 的事实字段覆盖，**省略可选字段会被重置为默认**（`category→横评`、`read_minutes→5`）——与 products「事实字段 sync 说了算」一致
- [ ] `related_product_ids` 未校验存在性（可能存悬空引用）
- [ ] SSRF 残留：DNS 解析与实际连接之间仍有 rebinding 时间窗（彻底封需 pin 已解析 IP 连接）；内部 token 已是第一道闸
- [ ] 图片先传 Storage 再写库：若 upsert 失败，已传的图成为孤儿（hash 路径幂等，重试会覆盖，不累积膨胀）
- [ ] re-sync 每次重抓重传所有图（hash 路径幂等 overwrite，浪费带宽）
- [ ] 图片转码 / 压缩（现在原样转存）；`PATCH` 单字段更新 + 限流（同 products 待办）
