# `POST /api/internal/products` — 入库 API（products）

| 字段 | 值 |
|---|---|
| 任务 | MOXIE-14 (T2 5/28) |
| 路径 | `POST /api/internal/products` |
| 认证 | `Authorization: Bearer <LATEMAI_INTERNAL_TOKEN>` |
| 幂等键 | `domain`（DB 层 unique 约束；按 domain 分 INSERT/UPDATE 两路径） |
| 入库状态 | 新建时 `status = 'pending'`（需 admin 后续审核才上架）；**re-sync 不重置 status** |
| 审计 | 每次请求落 `moxie_audit_logs` 一行 |

## Request

### Headers

| 名字 | 必填 | 说明 |
|---|---|---|
| `Authorization` | ✅ | `Bearer <token>` |
| `Content-Type` | ✅ | `application/json` |
| `X-Request-Id` | ❌ | 自定义请求追踪 ID（不填服务端生成 uuidv4） |

### Body (JSON)

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `slug` | string | ✅ | `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`，≤ 60 |
| `name` | string | ✅ | ≤ 60 |
| `domain` | string | ✅ | 形如 `example.com`，≤ 120，**幂等键** |
| `tagline` | string | ✅ | ≤ 30 |
| `description` | string | ❌ | ≤ 1500 |
| `category_slug` | string | ❌ | 必须是 `moxie_categories.slug` 已存在的值 |
| `tags` | string[] | ❌ | ≤ 8 个，每个 ≤ 8 字 |
| `price_label` | string | ❌ | ≤ 30，自由文本 |
| `domestic_available` | `yes` \| `partial` \| `no` | ❌ | 默认 `partial` |
| `data_overseas` | boolean | ❌ | 默认 `false` |
| `source` | object | ❌ | 任意溯源元数据（落 audit_log） |

## 幂等语义 · 新建 vs re-sync（重要）

按 `domain` 分两条路径，**写入的字段集不同**：

| 场景 | 行为 | 写入字段 |
|---|---|---|
| **新 domain（INSERT）** | 写全量行 | 事实字段 + `status='pending'` + `domestic_available` + `price_label` + `data_overseas`（缺省值见下） |
| **同 domain（re-sync UPDATE）** | **只刷事实字段** | `slug` / `name` / `tagline` / `description` / `tags` / `category_id` / `updated_at` |

re-sync 时**绝不触碰**这些"人工 / 运行时"字段（保留 admin 已编辑的值）：

```
status            ← admin 审核后可能已 published，不能被打回 pending
domestic_available ← admin 人工核实过国内可用性
price_label       ← admin 人工填过真实定价
data_overseas     ← admin 标过数据出境
vote_count        ← 用户真实投票，不能被覆盖
verified          ← admin 标记"子墨测过"
featured          ← admin 设的当周精选
```

> 这意味着：scanner / worker 反复 sync 同一个产品**只会刷新它的基础事实**（改名、改 tagline、补描述），
> 而 admin 的所有人工决策都安全保留。

新建时的缺省值：
- `status` = `pending`（强制，需 admin 审核才上架）
- `price_label` = `不详`（sync 数据不假设免费，比 DB 列默认 `免费` 更诚实）
- `domestic_available` = `partial`（拿不准时保守）
- `data_overseas` = `false`

## Response

### 成功

`201 Created`（新 domain）或 `200 OK`（同 domain，已更新）：

```json
{
  "ok": true,
  "request_id": "9f3c8a02-...",
  "data": {
    "id": 42,
    "slug": "cursor-ai",
    "domain": "cursor.com",
    "status": "pending",
    "inserted": true
  }
}
```

### 错误

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_PAYLOAD",
    "message": "slug must match ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
    "field": "slug",
    "request_id": "9f3c8a02-..."
  }
}
```

| HTTP | `error.code` | 含义 |
|---|---|---|
| 400 | `INVALID_PAYLOAD` | 字段缺失 / 类型错 / 长度超限 |
| 400 | `UNKNOWN_CATEGORY_SLUG` | `category_slug` 不在 `moxie_categories` |
| 400 | `SLUG_FORMAT` | slug 不符合正则 |
| 401 | `MISSING_TOKEN` | 缺 `Authorization` header |
| 403 | `INVALID_TOKEN` | token 不匹配 `LATEMAI_INTERNAL_TOKEN` |
| 405 | `METHOD_NOT_ALLOWED` | 用了非 POST |
| 500 | `INTERNAL_ERROR` | 服务端异常 |

---

## AC-5 手工 curl 实测

> 测试前需在 Vercel / `.env.local` 配 `LATEMAI_INTERNAL_TOKEN`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`，并跑过 `supabase/migrations/20260527140000_moxie_audit_logs.sql`。

### 1. 新建（首次 POST 一个新 domain）

```bash
export TOKEN="<你配的 LATEMAI_INTERNAL_TOKEN>"
export BASE="http://localhost:3000"   # 或 https://www.latemai.com

curl -sS -X POST "$BASE/api/internal/products" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: ac5-new-001" \
  -d '{
    "slug": "ac5-test-tool",
    "name": "AC5 Test Tool",
    "domain": "ac5test.example.com",
    "tagline": "T2 验收用的临时产品",
    "category_slug": "ai-coding",
    "tags": ["编程"],
    "price_label": "免费",
    "domestic_available": "yes"
  }' | jq
```

期望响应：

```json
{
  "ok": true,
  "request_id": "ac5-new-001",
  "data": {
    "id": <某个数字>,
    "slug": "ac5-test-tool",
    "domain": "ac5test.example.com",
    "status": "pending",
    "inserted": true
  }
}
```

HTTP status: `201 Created`

### 2. 重复 update（同 domain 二次 POST）

```bash
curl -sS -X POST "$BASE/api/internal/products" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: ac5-update-002" \
  -d '{
    "slug": "ac5-test-tool",
    "name": "AC5 Test Tool (改名了)",
    "domain": "ac5test.example.com",
    "tagline": "tagline 也变了",
    "category_slug": "ai-coding"
  }' | jq
```

期望响应：

```json
{
  "ok": true,
  "request_id": "ac5-update-002",
  "data": {
    "id": <跟上一步同一个 id>,
    "slug": "ac5-test-tool",
    "domain": "ac5test.example.com",
    "status": "pending",
    "inserted": false
  }
}
```

HTTP status: `200 OK`，`inserted` 变成 `false`，`id` 保持不变 = 幂等命中。

### 3. 校验失败用例

#### 缺 token
```bash
curl -sS -X POST "$BASE/api/internal/products" \
  -H "Content-Type: application/json" \
  -d '{}' -w "\n%{http_code}\n"
# → 401 MISSING_TOKEN
```

#### 缺必填字段
```bash
curl -sS -X POST "$BASE/api/internal/products" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "miss slug"}' -w "\n%{http_code}\n"
# → 400 INVALID_PAYLOAD field=slug
```

#### 用错 method
```bash
curl -sS -X GET "$BASE/api/internal/products" -w "\n%{http_code}\n"
# → 405 METHOD_NOT_ALLOWED
```

### 4. 审计核对

跑完上面 curl 后，去 Supabase Studio：

```sql
select endpoint, http_status, target_natural_key, error_code, latency_ms, created_at
from moxie_audit_logs
order by created_at desc
limit 10;
```

应该看到上面每次调用对应一行。`payload_sha256` 不为空，`token_fingerprint` 为同一个值（同一个 token），但 `request_id` 各异。

### 5. 清理

```sql
delete from moxie_products where domain = 'ac5test.example.com';
delete from moxie_audit_logs where request_id like 'ac5-%';
```

---

## 单测

跑：

```bash
npm run test
```

4 个情形（[src/app/api/internal/products/route.test.ts](../../src/app/api/internal/products/route.test.ts)）：

1. Missing token → 401 `MISSING_TOKEN`
2. Body 缺 required field → 400 `INVALID_PAYLOAD` field=slug
3. 新 domain → 201 `inserted=true`
4. 同 domain → 200 `inserted=false`

---

## 待办（不在 T2 范围）

- [ ] T6 (MOXIE-18) `POST /api/internal/articles` —— 复用本套 lib/sync 模块
- [ ] 限流 + idempotency_key header（T1 §4.5 设计但 T2 未实现）
- [ ] `PATCH /api/internal/products/{slug}` 显式更新单字段
- [ ] Webhook 反向通知（T1 §4.5 提议）
