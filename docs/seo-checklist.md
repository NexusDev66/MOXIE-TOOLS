# SEO 元数据 + sitemap + GSC 自动提交（T7 MOXIE-19）

| 字段 | 值 |
|---|---|
| 任务 | MOXIE-19 (T7 6/5) |
| 范围 | products/articles 详情页 metadata + Article JSON-LD + 动态 sitemap + Google Indexing 自动提交 |
| 站点域名 | env `NEXT_PUBLIC_SITE_URL`（默认 `https://latemai.com`），根 layout 设 `metadataBase` |

## 做了什么

### AC-1 详情页 metadata + schema.org
- **产品页** [/tools/[slug]](../src/app/tools/[slug]/page.tsx)：补全 `title / description / canonical / OpenGraph / Twitter`（数据来自静态 `@/lib/data`）。
- **文章页** [/articles/[slug]](../src/app/articles/[slug]/page.tsx)（**T7 新建**）：从 DB `moxie_articles` 读已发布文章（匿名 client 走 RLS，只看 published），`body_html` 经 **sanitize-html** 白名单消毒后渲染；带完整 metadata + **Article schema.org JSON-LD**（headline/description/image/datePublished/author/publisher）。
  - 路由用 `/articles/[slug]`（`/learn` 已被「学习路径」页占用）。

### AC-2 动态 sitemap
- [src/app/sitemap.ts](../src/app/sitemap.ts)（Next 16 原生约定）：静态主路由 + products（静态）+ articles（DB，带 `lastModified=published_at`）。
- DB 不可用时降级，仍输出静态 + products 部分。
- 访问 `/sitemap.xml` 即得。

### Schema Markup / JSON-LD（T12 MOXIE-25）
- `src/lib/seo/jsonld.ts`:`buildArticleJsonLd`(文章页 → `Article`)、`buildSoftwareApplicationJsonLd`(产品页 → `SoftwareApplication`)、`jsonLdScript`(序列化 + 转义 `<>&` 防 `</script>` 逃逸)。
- 注入:`/articles/[slug]` 与 `/tools/[slug]` 各注 `<script type="application/ld+json">`(文章页由 T7 内联重构到 lib,统一一处)。
- SoftwareApplication:免费/免费档输出 `Offer price 0`;付费无可靠数值价 → 不杜撰 offers。
- 单测 `jsonld.test.ts`(必填/可选省略/转义)。**Google Rich Results Test 需上线后用真实 URL 跑(或粘贴渲染 HTML);本地已验产品页渲染出合法 SoftwareApplication**(`@type/name/applicationCategory/operatingSystem` 齐全)。

### AC-3 Google Indexing API 客户端
- [src/lib/seo/indexing.ts](../src/lib/seo/indexing.ts)：`node:crypto` 签 RS256 JWT → 换 access token → 调 Indexing API,不引 SDK;两个 fetch 均带 10s 超时。
- 单测 [indexing.test.ts](../src/lib/seo/indexing.test.ts)：未配 skip / 正常流程 / API 报错 / 非法 SA。
- **⚠️ 文章不走 Indexing API**：Google Indexing API **官方只支持 `JobPosting` / 直播 `BroadcastEvent VideoObject`**,不收普通文章。本站文章是普通 `schema.org/Article`,即便调用成功也不会被当索引请求受理。**故文章入库后不自动调 Indexing API**(复审修正);**普通文章收录依赖上面的 sitemap + Search Console**。
- `notifyGoogleIndexing` 客户端保留,供将来支持的页面类型(招聘/直播)按需调用;**仅在页面类型符合 API 支持范围时才调**。

## ENV / Secret

| 变量 | 用途 | 哪配 |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | canonical/OG/sitemap 绝对 URL | Vercel env（不配用默认域名） |
| `GOOGLE_INDEXING_SA` | GCP 服务账号 JSON（`indexing.ts` 客户端用,**仅 JobPosting/VideoObject 类页面才需要**;普通文章不用) | 可选 |

### 普通文章如何被收录
**走 sitemap + Search Console**(不用 Indexing API):
1. 把 `/sitemap.xml` 提交到 Google Search Console。
2. GSC 会按 sitemap 抓取已发布文章;`lastModified` 帮助 Google 识别更新。
3. 无需服务账号 / 无需自动提交。

### (可选)Indexing API —— 仅支持的页面类型
若将来上招聘(`JobPosting`)或直播(`VideoObject`)页,才用 `notifyGoogleIndexing`:GCP 建服务账号→启用 Indexing API→该账号加为 GSC 站点所有者→JSON 塞 `GOOGLE_INDEXING_SA`。**不要对普通文章调它**(Google 不受理)。

## AC-5 Lighthouse SEO ≥ 95（验收手测）

```bash
npm run build && npm start          # 起生产构建
# Chrome DevTools → Lighthouse → SEO,跑 /articles/<某篇> 和 /tools/<某工具>
```
检查点:有 `<title>`/meta description/canonical、文档有 lang、图片有 alt、链接可爬、结构化数据无报错（可用 Google Rich Results Test 验 Article JSON-LD）。

## 单测

```bash
npx vitest run src/lib/seo/        # Indexing 客户端
npm run test                        # 全量
```

## 已知 / 不在范围

- `body_html` 已消毒（sanitize-html 白名单），但**未做内容审核**（信任入库来源）。
- products 仍由静态 `@/lib/data` 驱动；待公开站接 DB 后,sitemap 的 products 部分改读 `moxie_products`。
- Indexing API 有配额（默认 200/天）；批量回填需分批,不在 v0。
- `robots.txt`、OG 图片自动生成（`opengraph-image`）未做,后续可加。
