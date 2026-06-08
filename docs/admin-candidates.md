# Admin 候选审核页（`/admin/candidates`）

| 字段 | 值 |
|---|---|
| 任务 | MOXIE-15 (T3 5/29) |
| 路径 | `/admin/candidates` |
| 鉴权 | Supabase auth（cookie session）+ `moxie_profiles.role = 'admin'` |
| 数据源 | `moxie_trend_candidates`（status=pending，按 occurrence_count desc） |
| 升级出口 | 复用 T2 的 `upsertProductByDomain` 写 `moxie_products`（status=pending） |

## 功能

admin 登录后看到 pending 候选列表，每条可展开"升级表单"：
1. 填 slug / name / domain / tagline / 分类 / 价格 / 国内可用性 / 标签
2. 提交 → 写入 `moxie_products`（status=pending，待后续上架审核）
3. candidate.status `pending` → `promoted`，记 `promoted_product_id`
4. 也可"跳过"：candidate.status → `dismissed`

## 鉴权流程（AC-3）

```
请求 /admin/candidates
  → (authed)/layout.tsx 守卫
    → 未登录          → redirect /admin/login
    → 登录但非 admin   → forbidden()（HTTP 403，自定义 src/app/forbidden.tsx）
    → admin           → 渲染列表
```

- cookie session 由 `/admin/login` magic link + `/admin/auth/callback` 建立
- `getCurrentAdmin()`（`src/lib/admin/auth.ts`）用 React `cache()` 做请求级 memoization
- `moxie_trend_candidates` 的 RLS policy 本身只允许 `moxie_is_admin()` 读 —— 双重保险

> **403 vs 401**：未登录跳登录页（401 语义）；登录了但 role≠admin 返回真 HTTP 403（`forbidden()`，需 `next.config` 的 `experimental.authInterrupts`）。

## 升级动作怎么调 T2（设计决定）

**直接函数调用** `upsertProductByDomain`，**不走 HTTP 自调** `/api/internal/products`：

| 方式 | 取舍 |
|---|---|
| ✅ 直接函数调用（采用） | 同 app 内复用 T2 逻辑，不绕 token，不发自调 HTTP |
| ❌ HTTP 自调 | 任务字面"调 T2 API"，但同 app 自调要带 Bearer token、多一跳网络，浪费 |

promote action（`actions.ts`）复用 T2 的：
- `validateProductPayload`（同一套字段校验）
- `loadCategoryMap` + `upsertProductByDomain`（同一套幂等 upsert，status=pending）
- `writeAuditLog`（source 标 `admin_ui` 区别于 sync_api）

只跳过 Bearer token 校验那层 —— admin 已经 Supabase 登录鉴权。

> ⚠️ 这个设计决定跟邓晖确认过/待确认：如果坚持 HTTP 自调，改 actions.ts 几行即可。

## 文件结构

```
src/app/admin/
├── (authed)/
│   ├── layout.tsx                    # admin 守卫 + chrome
│   └── candidates/
│       ├── page.tsx                  # pending 列表
│       ├── promote-form.tsx          # 升级表单（client，可折叠）
│       └── actions.ts                # promoteCandidate / dismissCandidate
├── login/{page,login-form,actions}   # magic link 登录
└── auth/callback/route.ts            # PKCE 回调
src/app/forbidden.tsx                  # 自定义 403 页
src/lib/supabase/server.ts             # cookie session client
src/lib/admin/auth.ts                  # getCurrentAdmin DAL
```

## ENV

| 变量 | 用途 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 公开 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公开（cookie session client） |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅 server（promote 写库绕 RLS） |

## 部署要求

1. Supabase Auth → URL Configuration 加 redirect：`https://www.latemai.com/admin/auth/callback`
2. SQL 把目标邮箱设 admin：
   ```sql
   update moxie_profiles set role='admin'
   where user_id = (select id from auth.users where email='你的邮箱');
   ```

## 手工验证

```
1. /admin/candidates 未登录 → 跳 /admin/login
2. 用非 admin 邮箱登录 → /admin/candidates 返回 403（forbidden 页）
3. 用 admin 邮箱登录 → 看到 pending 候选列表
4. 点某条"升级" → 填表 → 提交
   → moxie_products 多一行（status=pending）
   → 该 candidate status=promoted，从列表消失
5. 另一条点"跳过" → candidate status=dismissed，从列表消失
```

## AC 自检

| AC | 落实 |
|---|---|
| AC-1 /admin/candidates 列表 + 升级表单 | page.tsx + promote-form.tsx |
| AC-2 升级动作调 T2 | actions.ts 复用 upsertProductByDomain |
| AC-3 admin 守门 + 非 admin 403 | (authed)/layout.tsx forbidden() + RLS |
| AC-4 candidate status pending→promoted | actions.ts promoteCandidate |
| AC-5 docs | 本文件 |

## 待办（不在 T3）

- [ ] T5 (MOXIE-17) AI 自动补全：升级表单预填 AI 草稿，admin 只需校对（现在全手填）
- [ ] 分页 / 搜索（现在固定显示前 50）
- [ ] T2 cosmetic nit：API 响应 status 反映真实 DB 值
