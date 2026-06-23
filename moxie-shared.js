/* MOXIE 共用脚本 · 给所有 .prow 自动注入访问外站的 ↗ 图标 + 全局互动 */
(function () {
  function injectVisitLink(row) {
    if (!row || row.classList.contains('featured-empty')) return;
    var img = row.querySelector('.plogo.has-img img, .top1-logo img');
    if (!img) return;
    var domain = img.getAttribute('data-domain')
      || (img.src.match(/domain=([^&]+)/) || [])[1]
      || (img.src.match(/ip3\/([^/]+)\.ico/) || [])[1];
    if (!domain) return;
    var url = 'https://' + domain + '?ref=moxie';
    var anchor =
      row.querySelector('.ptop') ||
      row.querySelector('.top1-head') ||
      row.querySelector('.ptitle');
    if (!anchor) return;
    if (anchor.querySelector('.visit-link')) return;

    var link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'visit-link';
    link.title = '访问 ' + domain;
    link.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M7 7h10v10"/></svg>';
    link.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    anchor.appendChild(link);
  }

  function highlightActiveNav() {
    var path = (location.pathname.split('/').pop() || 'moxie-preview.html').toLowerCase();
    document.querySelectorAll('.nav-center a[href]').forEach(function (a) {
      var href = (a.getAttribute('href') || '').split('/').pop().toLowerCase();
      if (href && href === path) a.classList.add('active');
    });
  }

  /* ───────── 全局 toast ───────── */
  function ensureToastEl() {
    var t = document.getElementById('moxie-toast');
    if (t) return t;
    t = document.createElement('div');
    t.id = 'moxie-toast';
    t.style.cssText =
      'position:fixed;left:50%;bottom:88px;transform:translateX(-50%) translateY(8px);' +
      'background:rgba(29,33,41,0.92);color:#fff;font-size:12.5px;padding:9px 16px;' +
      'border-radius:8px;z-index:9999;opacity:0;pointer-events:none;' +
      'transition:opacity .18s ease, transform .18s ease;' +
      'font-family:"Plus Jakarta Sans","Noto Sans SC",sans-serif;letter-spacing:0.01em;';
    document.body.appendChild(t);
    return t;
  }
  function toast(msg) {
    var t = ensureToastEl();
    t.textContent = msg;
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(t._timer);
    t._timer = setTimeout(function () {
      t.style.opacity = '0';
      t.style.transform = 'translateX(-50%) translateY(8px)';
    }, 1600);
  }
  window.moxieToast = toast;

  /* ───────── 投票 .pvote · 走 Supabase（未登录走 localStorage 兜底） ───────── */
  function wireVotes() {
    var KEY = 'moxie-votes';
    var voted = {};
    try { voted = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}

    document.querySelectorAll('.prow, .top1-card, .pick-mini').forEach(function (row) {
      var btn = row.querySelector('.pvote');
      if (!btn || btn.dataset.wired) return;
      btn.dataset.wired = '1';
      var productId = btn.dataset.productId ? Number(btn.dataset.productId) : null;
      var nameEl = row.querySelector('.pname, .top1-name, .pick-name');
      var fallbackKey = (nameEl && nameEl.textContent.trim()) || row.textContent.slice(0, 20);
      var numEl = btn.querySelector('.num');
      if (!numEl) return;
      var base = parseInt(numEl.textContent.replace(/[^\d]/g, ''), 10) || 0;

      var localState = !!voted[fallbackKey];
      if (localState) { btn.classList.add('voted'); }

      // 如果有 productId 且登录了，从 DB 查真实状态
      if (productId && window.MoxieDB) {
        window.MoxieDB.voteCheck(productId).then(function (yes) {
          if (yes) btn.classList.add('voted');
        });
      }

      btn.addEventListener('click', async function (e) {
        e.preventDefault();
        e.stopPropagation();

        // 优先走 DB
        if (productId && window.MoxieDB) {
          var res = await window.MoxieDB.voteToggle(productId);
          if (res && res.error === 'not-logged-in') {
            if (window.moxieToast) window.moxieToast('登录后才能投票');
            setTimeout(function(){ location.href = 'moxie-login.html'; }, 800);
            return;
          }
          if (res && res.voted) {
            btn.classList.add('voted','pulse');
            numEl.textContent = String(base + 1);
          } else {
            btn.classList.remove('voted');
            numEl.textContent = String(base);
          }
          setTimeout(function(){ btn.classList.remove('pulse'); }, 500);
          return;
        }

        // localStorage fallback（无 DB 或本地测试）
        if (voted[fallbackKey]) {
          delete voted[fallbackKey];
          btn.classList.remove('voted');
          numEl.textContent = String(base);
        } else {
          voted[fallbackKey] = 1;
          btn.classList.add('voted','pulse');
          numEl.textContent = String(base + 1);
          setTimeout(function(){ btn.classList.remove('pulse'); }, 500);
        }
        try { localStorage.setItem(KEY, JSON.stringify(voted)); } catch (e) {}
      });
    });
  }

  /* 暴露给各页 fetch 渲染完成后调用 */
  window.MoxieRewire = function () {
    document.querySelectorAll('.prow, .top1-card, .pick-mini').forEach(injectVisitLink);
    wireVotes();
  };

  /* ───────── 顶栏放大镜：本页有探索搜索框就跳过去聚焦，否则去首页 ───────── */
  function wireSearchTrigger() {
    document.querySelectorAll('.cmd-trigger').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        if (typeof window.moxieFocusSearch === 'function') {
          window.moxieFocusSearch();
        } else {
          location.href = 'moxie-preview.html#search';
        }
      });
    });
  }

  /* ───────── 首页 4 个 tabs (今日/本周/本月/年榜) ───────── */
  function wireRankTabs() {
    var tabs = document.querySelectorAll('.center-top .tabs .tab');
    if (!tabs.length) return;
    tabs.forEach(function (t) {
      t.style.cursor = 'pointer';
      t.addEventListener('click', function (e) {
        e.preventDefault();
        tabs.forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        var label = t.textContent.trim();
        if (label !== '今日') {
          toast(label + ' 榜单正在生成中，先看「今日」');
        }
      });
    });
  }

  /* blog cat-chip / business filter-item / aigc-tab：
     真过滤逻辑尚未实现，纯展示，不绑 click（避免假交互欺骗体感）。 */

  /* ───────── article TOC · 切 active（无锚点时仅视觉） ───────── */
  function wireArticleToc() {
    var items = document.querySelectorAll('.toc-list li');
    if (!items.length) return;
    items.forEach(function (li) {
      li.addEventListener('click', function () {
        items.forEach(function (x) { x.classList.remove('active'); });
        li.classList.add('active');
        var href = li.dataset.target;
        var target = href ? document.querySelector(href) : null;
        if (target) {
          var top = target.getBoundingClientRect().top + window.pageYOffset - 80;
          if (window.lenis && typeof window.lenis.scrollTo === 'function') {
            window.lenis.scrollTo(top);
          } else {
            window.scrollTo({ top: top, behavior: 'smooth' });
          }
        }
      });
    });
  }

  /* ───────── product 页 · 访问产品按钮指向真实 domain ───────── */
  function wireProductVisitButtons() {
    var hero = document.querySelector('.prod-hero, .product-hero, .pdetail-hero, body');
    if (!hero) return;
    var img = document.querySelector('.product-hero img, .pdetail-logo img, .ptop-logo img, main img[src*="favicons"], main img[src*="ip3/"], main img[data-domain]');
    if (!img) return;
    var domain = img.getAttribute('data-domain')
      || (img.src.match(/domain=([^&]+)/) || [])[1]
      || (img.src.match(/ip3\/([^/]+)\.ico/) || [])[1];
    if (!domain) return;
    var url = 'https://' + domain + '?ref=moxie';
    document.querySelectorAll('a').forEach(function (a) {
      var txt = (a.textContent || '').trim();
      if (/访问产品/.test(txt) && (a.getAttribute('href') || '') === '#') {
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
  }

  /* ───────── 登录后顶栏头像 + 下拉菜单 ───────── */
  function escHtml(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function wireUserMenu() {
    if (typeof window.moxieWhenDBReady !== 'function') return;
    window.moxieWhenDBReady(async function (db) {
      if (!db) return;
      var loginBtn = document.getElementById('loginBtn');
      if (!loginBtn) return;

      var email, handle, initial;
      var preload = window.__moxiePreloadUser;
      if (preload) {
        // 优先用同步 preload (moxie-supabase.js 顶部已从 localStorage 取出)
        // 这样跳过 getSession() 异步往返，与 CSS 头像占位无缝衔接
        email   = preload.email;
        handle  = preload.handle;
        initial = preload.initial;
      } else {
        // 没 preload 兜底用 getSession (例如刚 OAuth 跳回，localStorage 写入早于本脚本执行的极少数情况)
        var session = null;
        try {
          var res = await db.auth.getSession();
          session = res && res.data && res.data.session;
        } catch (e) { return; }
        if (!session || !session.user) return;
        email   = session.user.email || '';
        handle  = (email.split('@')[0] || 'user');
        initial = (handle.charAt(0) || 'U').toUpperCase();
      }

      var menu = document.createElement('div');
      menu.className = 'user-menu';
      menu.id = 'userMenu';
      menu.innerHTML =
        '<button class="user-avatar" type="button" aria-label="用户菜单" title="' + escHtml(handle) + '">' + escHtml(initial) + '</button>' +
        '<div class="user-dropdown" role="menu">' +
          '<div class="user-dropdown-head">' +
            '<div class="un">' + escHtml(handle) + '</div>' +
            '<div class="em">' + escHtml(email) + '</div>' +
          '</div>' +
          '<button class="user-dropdown-item" type="button" data-action="my-submits" role="menuitem">' +
            '<span>我的提交</span>' +
          '</button>' +
          '<button class="user-dropdown-item" type="button" data-action="favorites" role="menuitem">' +
            '<span>我的收藏</span>' +
          '</button>' +
          '<button class="user-dropdown-item" type="button" data-action="points" role="menuitem">' +
            '<span>我的积分</span><span class="meta">敬请期待</span>' +
          '</button>' +
          '<div class="user-dropdown-divider"></div>' +
          '<button class="user-dropdown-item danger" type="button" data-action="logout" role="menuitem">' +
            '<span>退出登录</span>' +
          '</button>' +
        '</div>';

      loginBtn.replaceWith(menu);

      var avatar   = menu.querySelector('.user-avatar');
      var dropdown = menu.querySelector('.user-dropdown');

      function setOpen(open) {
        var willOpen = (open === undefined) ? !dropdown.classList.contains('open') : open;
        dropdown.classList.toggle('open', willOpen);
        avatar.classList.toggle('open', willOpen);
      }

      avatar.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen();
      });
      document.addEventListener('click', function (e) {
        if (!menu.contains(e.target)) setOpen(false);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') setOpen(false);
      });

      menu.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.stopPropagation();
          var action = btn.getAttribute('data-action');
          setOpen(false);
          if (action === 'logout') {
            if (!confirm('注销当前账号？')) return;
            try { await db.auth.signOut(); } catch (_) {}
            location.reload();
          } else {
            window.moxieToast && window.moxieToast('这个功能正在开发，敬请期待');
          }
        });
      });

      // welcome toast (originally lived in preview.html inline)
      if (new URLSearchParams(location.search).get('welcome') === '1') {
        setTimeout(function () {
          window.moxieToast && window.moxieToast('欢迎，' + (email || '回来了'));
        }, 400);
        history.replaceState({}, '', location.pathname);
      }
    });
  }

  /* ───────── logo 本地化 + 兜底
     大陆访问:Google favicon(www.google.com/s2/favicons)被墙,运行时把这类 <img>
     改写成自托管 /public/logos/<domain>.png(同源,GFW 绕开);取不到则首字母兜底。
     覆盖静态 <img>、JS 模板、JS .src= 赋值(MutationObserver 接 src 变更),全站零页面改动。 ───────── */
  function moxieLogoFallback(img) {
    if (!img || img.dataset.logoFallback) return;
    img.dataset.logoFallback = '1';
    var box = img.parentElement;
    var ch = ((img.getAttribute('alt') || '').trim().charAt(0) || '?').toUpperCase();
    if (box && box.classList && box.classList.contains('plogo')) {
      box.classList.remove('has-img');
      box.textContent = ch;
      box.style.fontWeight = '700';
      box.style.fontSize = '14px';
    } else {
      img.src = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">'
        + '<rect width="128" height="128" rx="26" fill="#EFEDE7"/>'
        + '<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" '
        + 'font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="62" font-weight="700" fill="#A89F8C">' + ch + '</text></svg>');
    }
  }
  window.moxieLogoFallback = moxieLogoFallback;

  function moxieLocalize(img) {
    if (!img || img.tagName !== 'IMG') return;
    var src = img.getAttribute('src') || '';
    var domain = null, fromGoogle = false;
    var gm = src.match(/s2\/favicons\?domain=([^&"']+)/);
    if (gm) { domain = decodeURIComponent(gm[1]); fromGoogle = true; }                 // 残留 Google favicon
    else { var lm = src.match(/\/public\/logos\/([^"'?]+)\.png/); if (lm) domain = lm[1]; }  // 已本地的 logo
    if (!domain) return;
    img.setAttribute('data-domain', domain);
    if (!img.dataset.logoErrWired) { img.dataset.logoErrWired = '1'; img.onerror = function () { moxieLogoFallback(img); }; }
    if (fromGoogle) img.setAttribute('src', '/public/logos/' + domain + '.png');        // 仅 Google 才改写,防循环
  }
  function moxieLocalizeLogos(root) {
    (root || document).querySelectorAll('img[src*="s2/favicons"], img[src*="/public/logos/"]').forEach(moxieLocalize);
  }
  window.moxieLocalizeLogos = moxieLocalizeLogos;
  try {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var mu = muts[i];
        if (mu.type === 'attributes') { if (mu.target && mu.target.tagName === 'IMG') moxieLocalize(mu.target); }
        else if (mu.addedNodes) {
          for (var j = 0; j < mu.addedNodes.length; j++) {
            var n = mu.addedNodes[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'IMG') moxieLocalize(n);
            else if (n.querySelectorAll) n.querySelectorAll('img[src*="s2/favicons"], img[src*="/public/logos/"]').forEach(moxieLocalize);
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  } catch (e) {}
  moxieLocalizeLogos();                    // 立即处理已在 DOM 里的静态 favicon,尽早取消 Google 请求

  /* ───────── 分类 ▾ 下拉菜单:从数据库动态渲染(真实分类 + 真实计数) ─────────
     HTML 里 .mega-grid 是空容器(data-mega-grid),静态页不再写死任何分类/数字,
     避免编造的占位分类与假计数(SEO 也看不到假数)。在此按真实库填充。 */
  function wireMegaMenus() {
    var grids = document.querySelectorAll('[data-mega-grid]');
    if (!grids.length || typeof window.moxieWhenDBReady !== 'function') return;
    var LABEL = { aigc: 'AIGC 创作', platform: '模型 / 平台', devtool: '开发者 / 效率', biz: '商业 / 行业' };
    var ORDER = ['aigc', 'platform', 'devtool', 'biz'];
    window.moxieWhenDBReady(async function (db) {
      if (!db || !window.MoxieDB) return;
      try {
        var r1 = await window.MoxieDB.categories();
        var cats = (r1 && r1.data) || [];
        if (!cats.length) return;
        // 走 MoxieDB(优先同源快照,国内可达);不直连 Supabase,避免大陆拉不到导致菜单空
        var r2 = await window.MoxieDB.products({ limit: 2000 });
        var prods2 = (r2 && r2.data) || [];
        var cnt = {};
        prods2.forEach(function (p) { if (p.category_id != null) cnt[p.category_id] = (cnt[p.category_id] || 0) + 1; });
        // 全站「收录总数」实时同步:填所有 .js-tool-count(页脚 / 登录页等),不再写死 3,847
        if (prods2.length) document.querySelectorAll('.js-tool-count').forEach(function (e) { e.textContent = prods2.length; });
        var groups = {};
        cats.forEach(function (c) { (groups[c.group_name] = groups[c.group_name] || []).push(c); });
        var keys = ORDER.filter(function (k) { return groups[k]; })
          .concat(Object.keys(groups).filter(function (k) { return ORDER.indexOf(k) < 0; }));
        var html = keys.map(function (g) {
          var list = groups[g].filter(function (c) { return (cnt[c.id] || 0) > 0; });  // 隐藏空分类
          if (!list.length) return '';
          var sum = list.reduce(function (s, c) { return s + (cnt[c.id] || 0); }, 0);
          var items = list.map(function (c) {
            var href = '/moxie-models.html?group=' + encodeURIComponent(g) + '&cat=' + encodeURIComponent(c.slug);
            return '<li><a href="' + href + '"><span>' + escHtml(c.name) + '</span><span class="cnt">' + (cnt[c.id] || 0) + '</span></a></li>';
          }).join('');
          return '<div class="mega-col"><h4>' + escHtml(LABEL[g] || g || '其他') + ' <span class="h4-tag">' + sum + '</span></h4><ul>' + items + '</ul></div>';
        }).join('');
        grids.forEach(function (el) { el.innerHTML = html; });
        var nonEmpty = cats.filter(function (c) { return (cnt[c.id] || 0) > 0; }).length;
        document.querySelectorAll('[data-mega-all]').forEach(function (a) { a.textContent = '查看全部 ' + nonEmpty + ' 个分类 →'; });
      } catch (e) {}
    });
  }

  function run() {
    moxieLocalizeLogos();
    document.querySelectorAll('.prow, .top1-card, .pick-mini').forEach(injectVisitLink);
    highlightActiveNav();
    wireVotes();
    wireSearchTrigger();
    wireRankTabs();
    wireArticleToc();
    wireProductVisitButtons();
    wireUserMenu();
    wireMegaMenus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
