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

## 3. 🟠 功能 bug · `moxie-product.html` 客户端渲染漏更新「访问产品官网」按钮

**位置**:`moxie-product.html` ——
- 第 564 行:侧栏按钮写死 `<a href="https://deepseek.com?ref=moxie" ... class="btn-block primary">访问产品官网 ↗</a>`(模板默认 DeepSeek)。
- 第 ~720 行:客户端 hydrate 时 `document.getElementById('phVisit').href = ...` **只更新了顶部 phVisit 按钮**,**没更新这个侧栏按钮**(它无 id)。

**后果**:走客户端渲染的 `/moxie-product?slug=X` 路径,**任何产品**的「访问产品官网」都跳 **deepseek.com**(用户实测 GitHub Copilot 页跳错站)。

**改法**:给侧栏按钮加个 id(如 `phVisitOfficial`),client JS 里同样设其 `href`:
```js
document.getElementById('phVisit').href = `https://${p.domain}?ref=moxie`;
document.getElementById('phVisitOfficial').href = `https://${p.domain}?ref=moxie`; // 新增
```

> 注:**预渲染的 `/tools/<slug>` 静态页(用户主要入口)已由数据管道侧 `cli/prerender.js` 修复**(替换该按钮 deepseek→真实域名)。此条仅针对**客户端渲染路径**,归 UI。

---

## 4. 🟢 共享导航 mega-menu 写死假计数

**位置**:`moxie-product.html`(及其他页共享的顶部「分类」下拉)——如 `AI 编程 <span class="cnt">41</span>`、`查看全部 24 个分类`。
**问题**:计数(41/18/12…)是演示假数据;"24 个分类"实际只有 **10 个**。全站每页(含首页)都有。
**改法**:用真实分类 + 计数渲染该下拉,或至少把"24"改对。属装饰性,优先级低。

---

*发现日期:2026-06-10(#1#2)/ 2026-06-11(#3#4)· 来源:数据管道开发期自审 + 用户实测*
