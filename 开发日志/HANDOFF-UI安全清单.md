# 交接 · 静态 UI 安全清单(给负责 UI 上线的人)

> 背景:这两条是**做数据管道时顺带发现的 UI 层问题**,不在管道职责内,交给负责静态 UI 的人处理。
> 重要:本仓库(moxie-main)只是数据管道基座。**latemai.com 实际上线的是另一份 UI**,而它大概率是从同一母本 fork 的——所以请在**你真正部署的那份文件**的相同位置核对并修复,改这里的副本不会同步到生产。
>
> 定级:产品列表/详情两条渲染路径(prerender 的 `esc()`、客户端的 `escH/escapeHtml`)**默认都转义**,所以整体 XSS 风险不高。下面是**残留的两处**,建议上线前后修掉。

---

## 1. 🟡 存储型 XSS · `moxie-preview.html`(聊天推荐卡片)

**位置**:`moxie-preview.html` 第 1215 行附近,`cardsHtml` 模板里。

**现状**(同一个 `r.name` 在 1217 行转义了,1215 行却没有):
```js
<img src="https://www.google.com/s2/favicons?domain=${r.domain}&sz=128" alt="${r.name}">
```
`r` 来自数据库产品数据。若某产品 `name` 含 `"><img src=x onerror=alert(1)>`,会突破 `alt` 属性执行脚本。

**改法**:
```js
<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(r.domain)}&sz=128" alt="${escapeHtml(r.name)}">
```

**自查**:全局搜 `${r.` / `${p.` / `${x.`,确认凡是落进 HTML 属性或文本的产品字段(name/tagline/domain/desc)都包了 `escapeHtml/escH`。本文件其余产品渲染点已转义,仅此一处遗漏。

---

## 2. 🟢 `prerender.js` 的 `esc()` 漏转义单引号 `'`

**位置**:`cli/prerender.js` 第 33-35 行。

**现状**(只转义 `& < > "`):
```js
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```
仅当有**单引号包裹的 HTML 属性**且插了用户数据时才有突破风险。目前烤页多用双引号,影响小;但与客户端 `escH`(已含 `'`)口径不一致。

**改法**(补一条,口径统一):
```js
.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
```

---

*发现日期:2026-06-10 · 来源:数据管道开发期自审(上帝视角复查)*
