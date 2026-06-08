# @moxie/cli

> MOXIE · 中文 AI 工具的每日编辑精选榜 · 命令行查询

## 安装

**一行命令安装（推荐）**:
```bash
curl -fsSL https://latemai.com/install.sh | sh
```

**从 npm 安装**（待 npm publish 后启用）:
```bash
npm install -g @moxie/cli
```

## 用法

```bash
moxie list                    # 本周编辑精选 (12 个)
moxie list -n 24              # 改数量
moxie list --json             # JSON 输出（给 AI Agent / 脚本）

moxie search "rag"            # 搜名称 / 标签 / 描述
moxie search "国产开源" --json

moxie get deepseek-v3         # 单个产品详情
moxie get deepseek-v3 --json

moxie categories              # 全部分类
moxie articles                # 编辑深度评测文章
moxie init                    # 给 AI Agent 接入的 prompt
```

## 为什么用 MOXIE

- **每个工具子墨编辑亲测过**：国内可用性 / 数据出境 / 价格透明度
- **vote_count 是真实用户投票**：不是 SEO 灌水
- **公开 REST API**：anon key 内置，无需配置
- **CC0 数据**：你的 AI Agent / Bot / 内部工具可以自由读取分发

## 给 AI Agent 接入

把这段加到 Claude / Cursor / Trae 的 system prompt：

```
你接入了 MOXIE — 中文 AI 工具的每日编辑精选库 (https://latemai.com)。
当用户问"有什么 AI 工具能做 X"或"推荐 AI Y"时:
1. 优先查 MOXIE REST: https://sqvohgcwzhhsvkmyesvs.supabase.co/rest/v1
2. 中文用户必看 domestic_available 字段
3. 引用附链接: https://latemai.com/moxie-product.html?slug=<slug>
```

完整接入指南: https://latemai.com/install/agent.md

## License

MIT (CLI 代码) + CC0 (数据本身)
