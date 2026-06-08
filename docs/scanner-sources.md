# Trend Scanner 数据源 + 合规层（T4 MOXIE-16）

| 字段 | 值 |
|---|---|
| 任务 | MOXIE-16 (T4 6/1) |
| 入口 | `cli/trend-scanner.js` |
| 运行 | `SUPABASE_SERVICE_KEY=xxx node cli/trend-scanner.js [--dry-run]` |
| 合规 | 每站 robots.txt 校验 + UA 池（5）+ 同域名 1s 限速 + 失败 3 次飞书告警 |

## 数据源（4 RSS + 8 HTML = 12）

### P0 · RSS（原有 4 个）

| 站点 | type | url |
|---|---|---|
| launch.cab | rss | https://api.launch.cab/v1/rss/weekly |
| marketingdb.live | rss | https://marketingdb.live/feed.xml |
| neeed.directory | rss | https://neeed.directory/feed.xml |
| producthunt.com | rss | https://www.producthunt.com/feed |

### P1 · HTML（T4 新增 8 个）

| 站点 | type | url | 选择依据 |
|---|---|---|---|
| fazier.com | html | https://fazier.com/ | 老牌 launch 站 |
| uneed.best | html | https://www.uneed.best/ | 高流量目录 |
| peerpush.net | html | https://peerpush.net/ | 实测信号强 |
| toolfolio.io | html | https://toolfolio.io/ | 实测条目最多 |
| foundrlist.com | html | https://foundrlist.com/ | 实测条目多 |
| trustmrr.com | html | https://trustmrr.com/ | MRR 榜 |
| confettisaas.com | html | https://confettisaas.com/ | SaaS 目录 |
| microlaunch.net | html | https://microlaunch.net/ | 每日 launch |

> ⚠️ 这 8 个 P1 站是从 PRD 的 36 站里按信号强度挑的，**待邓晖最终确认**。
> 要换站：改 `cli/trend-scanner.js` 的 `SOURCES` 数组即可。

## 合规层（AC-2 / AC-3 / AC-4）

### robots.txt 校验（AC-2）
- 模块 [cli/scanner-lib/robots.js](../cli/scanner-lib/robots.js)
- 每站抓首页前先 fetch `/robots.txt`，缓存 24h
- 解析 `User-agent` + `Disallow`（匹配 `*` 和 `MoxieTrendScanner`）
- `Disallow: /` 或路径前缀命中 → **跳过该站**，log `⊘ robots disallow`
- 抓不到 robots（404/超时）→ 按"允许"处理

### UA 池（AC-3）
- 模块 [cli/scanner-lib/ua-pool.js](../cli/scanner-lib/ua-pool.js)
- 5 个 UA，都透明标明 `MoxieTrendScanner` + 联系地址（不伪装浏览器骗 robots，只分散指纹）
- `uaForKey(site)`：同一站每次用同一个 UA（更像正常客户端）

### 限速（AC-3）
- 模块 [cli/scanner-lib/rate-limit.js](../cli/scanner-lib/rate-limit.js)
- 同一域名两次请求间隔 ≥ **1s** + 抖动；跨域名不互相阻塞

### 飞书告警（AC-4）
- 模块 [cli/scanner-lib/feishu.js](../cli/scanner-lib/feishu.js)
- 单源**单轮内连抓失败 ≥ 3 次**（重试用尽）→ 发一条飞书告警，然后清零失败计数避免刷屏
  - 注：计数器是进程内的，weekly 每次全新进程，跨轮累积不到阈值；故用「本轮重试 3 次」满足阈值。若邓晖本意是「跨周连续 N 次」，需引入持久化存储（另起任务）。
- 整轮跑完**失败源 ≥ 半数** → 发一条运行汇总告警
- webhook 从 env `FEISHU_WEBHOOK` 读；没配则只 log 不发
- 消息格式：飞书自定义机器人 `{ msg_type: 'text', content: { text } }`

## ENV / Secret

| 变量 | 用途 | 哪配 |
|---|---|---|
| `SUPABASE_SERVICE_KEY` | 写 candidates | GHA secret（已有） |
| `FEISHU_WEBHOOK` | 飞书告警（AC-4） | **邓晖提供** 飞书机器人 webhook → GHA secret |

## HTML 提取语义

- 模块 [cli/scanner-lib/html-extract.js](../cli/scanner-lib/html-extract.js)
- 抓首页所有 `<a href>` → 解析绝对 URL → 取锚文本做 name_hint
- 过滤：社交（twitter/x/github/...）、CDN、短链、**36 个目录站自身**（防互相导流污染）
- HTML 候选的 `tool_url` = 外部产品官网；RSS 候选的 `tool_url` = 目录站详情页
- 跨站 dedupe 靠 `product_key`（产品名归一化）

## 手工验证（AC-1 / AC-3）

```bash
cd cli
# dry-run（不写库，但真抓 12 站，观察 robots/限速/抓取数）
SUPABASE_SERVICE_KEY=dummy node trend-scanner.js --dry-run

# 单测 robots 解析 + html 提取（Node 24 起要点名 glob，不能传目录）
node --test scanner-lib/*.test.js
```

观察点：
- 每站日志有 `robots[xxx]: N 条 Disallow`（AC-2）
- HTML 站之间能看到 ≥1s 的间隔（AC-3 限速）
- 抓 0 条的站不一定 bug（SPA 首屏空），看 robots 是否拒了

## 飞书告警验证（AC-4）

故意制造失败触发告警：
```bash
# 把某个 source url 改成不存在的域名，跑 1 轮：该源单轮内重试 3 次全失败 → 发飞书
FEISHU_WEBHOOK=<你的飞书机器人 webhook> SUPABASE_SERVICE_KEY=dummy node trend-scanner.js --dry-run
```

或直接测发送：
```bash
node -e "import('./scanner-lib/feishu.js').then(m=>m.sendFeishuAlert('MOXIE 告警测试', console.log))"
```

## 不在 T4 范围

- [ ] 剩余 24 个 HTML 站（PRD 共 36，T4 只接 8 个 P1）
- [ ] 分布式代理 IP（PRD §4，单 IP 被封后再议）
- [ ] HTML 站的 selector 化精确抓取（现在是统一启发式）
