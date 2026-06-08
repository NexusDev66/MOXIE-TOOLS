/* MOXIE 共用脚本 · 给所有 .prow 自动注入访问外站的 ↗ 图标 + 全局互动 */
(function () {
  function injectVisitLink(row) {
    if (!row || row.classList.contains('featured-empty')) return;
    var img = row.querySelector('.plogo.has-img img, .top1-logo img');
    if (!img || !img.src) return;
    var match = img.src.match(/domain=([^&]+)/);
    if (!match) return;
    var domain = match[1];
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
    var img = document.querySelector('.product-hero img, .pdetail-logo img, .ptop-logo img, main img[src*="favicons"]');
    if (!img) return;
    var match = img.src.match(/domain=([^&]+)/);
    if (!match) return;
    var url = 'https://' + match[1] + '?ref=moxie';
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

  function run() {
    document.querySelectorAll('.prow, .top1-card, .pick-mini').forEach(injectVisitLink);
    highlightActiveNav();
    wireVotes();
    wireSearchTrigger();
    wireRankTabs();
    wireArticleToc();
    wireProductVisitButtons();
    wireUserMenu();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
