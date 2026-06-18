# 收敛到 latemai.com 真站 · 一键打通 checklist

> 方向(肖总定):latemai.com 是真站,和 moxie 同一个 Supabase,**不需要 HTTP API**。
> 目标:在这套 UI 上把产品 **AI 清洗 → 权重定时更新 → SEO**,数据打通。
> 现状:生产库(`sqvohgcwzhhsvkmyesvs`)只有 12 个真工具、无 detail/无权重/无 SEO,另有 306 灰产候选(从没清洗)。
> 所有 cli 脚本已就绪且直连 Supabase,只差**指向生产库 + 把 SEO 产物落到 latemai.com**。

---

## 0. 前置(只有你/肖总能给)

| # | 需要 | 怎么给 | 用途 |
|---|---|---|---|
| A | 生产库 **service key** | Supabase 加我成员,或放进本仓库 GH secret(**别贴进对话**) | 写 detail/权重/清洗,跑迁移 |
| B | **latemai.com 部署方式** | 告诉我哪个仓库/平台在服务它(Vercel?某 repo?) | 把 prerender 的静态 SEO 页落过去 |
| C | 确认 **SITE_BASE_URL** | latemai.com(canonical/sitemap/IndexNow 用) | SEO 域名 |

> 关键认知:**首页列表 / 详情页是客户端实时读生产库渲染的** —— 一旦清洗/权重写进库,latemai.com 动态部分**立即生效,无需部署**。只有预渲染的静态 SEO 页(`tools/*.html`、`sitemap.xml`)需要落到 latemai 的部署。

---

## 1. 配置生产环境变量(本地 `.env.prod`,不进仓库)

```ini
# .env.prod  —— 注意:cli 用 ROLE_KEY,scanner 用 SERVICE_KEY,两个名都设成同一把生产 key
NEXT_PUBLIC_SUPABASE_URL=https://sqvohgcwzhhsvkmyesvs.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<生产 anon key(公开)>
SUPABASE_SERVICE_ROLE_KEY=<生产 service key>
SUPABASE_SERVICE_KEY=<同上>
DEEPSEEK_API_KEY=<DeepSeek key>
SITE_BASE_URL=https://www.latemai.com
```

之后所有命令都用 `--env-file=.env.prod` 指向生产库。

---

## 2. 备份(动手前先导出,可回滚)

```bash
# 导出生产库关键表为 JSON(用 service key)
node --env-file=.env.prod cli/_backup.js   # 见步骤末:可临时用 curl 导 moxie_products/news/articles
```
> 没有 _backup.js 也行:Supabase Dashboard → Database → Backups 确认有自动备份;或我写个 5 行导出脚本。

---

## 3. 应用 schema 迁移(补 detail / weight_score / traffic_jsonb / news 列)

**3.0 先体检,别盲迁**:跑 schema 对比,自动列出生产库缺的表/列 + 补齐 SQL(只读,不改库):
```bash
# .env.local 里加 PROD_SUPABASE_URL + PROD_SERVICE_ROLE_KEY(肖总给的生产 key)后:
node --env-file=.env.local cli/check-prod-schema.mjs
```
它会以**沙盒 schema 为基线**,逐表 diff 生产库,输出「缺哪些列 + `alter table ... add column` SQL」,并提示 OpenAPI 看不到、需人工确认的点(domain UNIQUE / status 取值 / RLS / 触发器 search_path / jsonb 类型)。先按它的报告补齐,再走下面的迁移。

- 方式一(推荐):`supabase link` 到生产项目后 `supabase db push`
- 方式二:在生产库 SQL Editor 直接执行 `supabase/migrations/20260615120000_latemai_pipeline_align.sql`
- 若生产库还缺 `moxie_news / moxie_voices / moxie_trend_candidates` 等**整表**,把 `supabase/migrations/` 下对应迁移一并执行。

验证:`moxie_products` 出现 `detail / weight_score / traffic_jsonb` 列。

---

## 4. AI 清洗 12 个产品(先 dry-run,再真跑)

```bash
# 4.1 详情(核心特点 + 短评 + 价格)
node --env-file=.env.prod cli/enrich-detail.js --fetch --dry-run    # 看抓官网+生成质量
node --env-file=.env.prod cli/enrich-detail.js --fetch              # 真写

# 4.2 子墨短评(第一人称实测口吻)
node --env-file=.env.prod cli/refresh-review.js --dry-run --limit 3
node --env-file=.env.prod cli/refresh-review.js

# 4.3 完整评测长文(4 段,事实准确护栏)
node --env-file=.env.prod cli/refresh-fullreview.js --all --dry-run --limit 2
node --env-file=.env.prod cli/refresh-fullreview.js --all
```
验证:抽 1-2 个产品看 detail 内容准确(参照本会话对 142 款做过的事实审计标准)。

---

## 5. 权重定时更新(rank)

```bash
node --env-file=.env.prod cli/fetch-traffic.js      # 拉流量真信号(可选,失败不阻塞)
node --env-file=.env.prod cli/rank.js               # 重算 weight_score
```
验证:`moxie_products.weight_score` 有值;latemai.com 首页排序立即按权重变化(动态读库)。

---

## 6. 清掉 306 灰产候选(用已验证的 gate)

```bash
# 已就绪的 prefilter+gate 能识别灰产;对 moxie_trend_candidates 批量标记/删除
# (若需要,我补一个 cli/clean-candidates.js:遍历候选 → prefilter+gate 判 → 灰产标 rejected)
```
> 注:候选清理脚本我可在权限到位后补(20 行内),逻辑复用现成 `prefilter`/`gate`,只读判定 + 标记 rejected,不误删真工具。

---

## 7. SEO(prerender + sitemap + IndexNow)

```bash
node --env-file=.env.prod cli/prerender.js          # 烤 tools/articles/news 静态页(含 JSON-LD)
node --env-file=.env.prod cli/sitemap.js            # 生成 sitemap.xml(base=latemai.com)
node --env-file=.env.prod cli/gen-covers.js         # 文章封面(若有文章)
node cli/indexnow.js                                # 提交 URL 给搜索引擎
```
验证:`tools/<slug>.html` 含 SoftwareApplication JSON-LD;sitemap 用 latemai.com 域名。

---

## 8. 把静态 SEO 产物部署到 latemai.com(取决于步骤 0-B)

- 若 latemai.com = 某仓库的静态部署:把 `tools/ articles/ news/ sitemap.xml robots.txt public/ <indexnow-key>.txt` 推到那个仓库。
- 若 latemai.com = 本仓库的 Vercel(改 SITE_BASE_URL 即可):设 var 后触发部署。
- 动态部分(首页/详情)已随步骤 4-5 的 DB 更新即时生效,无需等部署。

验证:`curl https://www.latemai.com/tools/<slug>` 能看到 JSON-LD;`/sitemap.xml` 200。

---

## 9. 端到端验证

- [ ] latemai.com 首页 12 工具按权重排序、有子墨短评
- [ ] 详情页有「核心特点/子墨测评/完整评测」且内容准确
- [ ] `tools/*.html` 有 JSON-LD;`sitemap.xml` 200;IndexNow 已提交
- [ ] `moxie_trend_candidates` 灰产已标 rejected,无杂牌

---

## 10. 定时自动化指向生产(打通后常态运行)

把 GitHub Actions 的仓库 **Variables/Secrets** 指向生产库(`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `DEEPSEEK_API_KEY` / `SITE_BASE_URL=latemai.com`),现有 workflow 即按生产库运行:
- `refresh.yml`(每日):候选上架 → rank → 封面 → prerender → sitemap → IndexNow → 同步
- `articles-weekly.yml`(每周):AI 文章
- `discover-weekly.yml` / `trend-scanner`(中文源 + prefilter)→ 新工具入库
- `enrich-weekly.yml`:详情重抓

---

## 迁移弹药(脚本状态)
- ✅ `cli/check-prod-schema.mjs`:迁移前 schema 体检(沙盒 vs 生产 diff + 补齐 SQL)— **已就绪**
- ✅ `cli/clean-candidates.js`:批量筛灰产候选(prefilter+gate 标 rejected)— **已就绪**
- ✅ `cli/promote-candidates.js`:自动上架已加反灰产末闸(prefilter 拦目录站/灰产 TLD)— **已就绪**
- ⬜ `cli/_backup.js`:导出生产库关键表 JSON(动手前备份)— 占位,迁移前我补全(<30 行)

## 可选决策(你定)
- **是否把沙盒已精修的内容迁到生产**:沙盒有 142 款(含完整 AI 清洗 + 权重 + 封面),生产只有 12。可只清洗这 12,也可把沙盒里真实中文 AI 工具的成品内容迁过去(我写一次性迁移脚本,按 domain 对齐、不覆盖人工字段)。
