# 自动配图 v0 · Playwright 截官网首屏 → moxie-covers（T9 MOXIE-22）

| 字段 | 值 |
|---|---|
| 任务 | MOXIE-22 (T9 6/10) |
| 入口 | admin 候选审核页 → 每条候选展开 → 「📸 截图」按钮 |
| 产出 | `moxie_trend_candidates.screenshot_url`;升级候选时带入 `moxie_products.cover_url` |
| 存储 | Supabase Storage bucket `moxie-covers`,路径 `products/<slug>/landing.<ext>` |

## 流程

```
admin 点「截图」
  → captureCandidateCover(candidateId)   [server action, requireAdmin]
  → captureAndStoreCover(sb, { slug, url })
      ├ SSRF 校验(私网/localhost/非 http → 拒)
      ├ 1. captureLandingScreenshot(url)   Playwright headless 截首屏(1920x1080, 等 3s)
      ├ 2. 截不到 → fetchFallbackImage(url)  OG image → favicon(Google 服务)
      ├ 3. 传 moxie-covers/products/<slug>/landing.<ext>(upsert)
      └ 返回公网 URL + source(screenshot|og|favicon|none)
  → 写 candidate.screenshot_url + audit_log
admin 升级该候选 → promoteCandidate 把 screenshot_url 带入 product.cover_url(best-effort)
```

## ⚠️ Serverless 部署(重要,否则截图不工作)

`playwright-core` **不自带 Chromium 二进制**,Vercel 函数体积也装不下完整 Chromium。

- **生产**:装 `@sparticuz/chromium`,把它的 `executablePath()` 经 env **`CHROMIUM_EXECUTABLE_PATH`** 注入;`maxDuration=60`(已在候选页设)给 Playwright 留执行预算。
- **本地 / 未配 `CHROMIUM_EXECUTABLE_PATH`**:`chromium.launch()` 失败 → `captureLandingScreenshot` 返回 `null` → **自动降级走 OG image / favicon**(AC-2 失败兜底)。
- 也就是说:**不配 chromium 不会报错,但封面会一直是 OG/favicon,拿不到真实首屏截图**。要真截图必须配好上面这两项。

## 安全:SSRF 防护(对齐 T6 cover-import)

截图导航 + 兜底抓图都走候选 URL(外部),故全程防 SSRF:
- 入口校验 `input.url`:拒 localhost / `*.local` / `*.internal` / 私网 IP(含 DNS 解析后判私网)/ 非 http(s)。
- `og:image` URL(来自页面 HTML,攻击者可控)抓前**单独再校验**。
- `fetch` / `page.goto` 用**手动跟重定向、每跳校验**(`safeFetch` + goto 后校验 `page.url()`),封「公网 URL 302 跳内网」绕过(≤3 跳)。

## 兜底链

| 优先级 | 来源 | 条件 |
|---|---|---|
| 1 | Playwright 首屏截图 | chromium 可用且抓到非空 buffer |
| 2 | OG image(`og:image`) | 页面有 og:image、通过 SSRF 校验、content-type image/*、≤8MB |
| 3 | favicon | Google favicon 服务(`s2/favicons?domain=`) |
| 4 | 无(`source: 'none'`) | 以上都失败 → 不写封面、返回 error |

## AC 对应

- AC-1 `src/lib/screenshot/landing.ts` + `playwright-core` 依赖 ✓
- AC-2 失败兜底(OG image / favicon)✓
- AC-3 admin 候选审核页加「截图」按钮 ✓
- AC-4 `maxDuration=60` 防 serverless 超时 ✓
- AC-5 单测 mock Playwright(`landing.test.ts`,8/8,含 SSRF/兜底/上传失败)✓

## 验证 / 待办

- 单测:`npx vitest run src/lib/screenshot/`(mock Playwright + mock dns + mock storage,8/8)。
- **真实截图验证延后**:需在装好 `@sparticuz/chromium` + 配 `CHROMIUM_EXECUTABLE_PATH` 的环境(或本地装完整 chromium)真跑一次,确认能截到首屏并存进 `moxie-covers`。

## 不在 v0 范围

- 截图重试 / 队列;图片压缩;截图质量评分(挡空白页);按产品 slug(而非 domain)组织 Storage 路径。
