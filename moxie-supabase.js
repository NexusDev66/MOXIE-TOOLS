/* MOXIE · Supabase Client
   用法：
   1. 在 https://supabase.com 新建项目「moxie」
   2. Project Settings → API 拿到 URL 和 anon key
   3. 替换下面两个常量
   4. 在 Authentication → Providers 启用 GitHub + Google
   5. Authentication → URL Configuration 加上你的部署域名
*/
const MOXIE_SUPABASE_URL  = 'https://kyiqgvxvbxktiygohuqh.supabase.co';
const MOXIE_SUPABASE_ANON = 'sb_publishable_QDAR-tJjJpV4jpeDOAt76w_xoEwfHma';

/* ───────── 同步预渲染登录态 (body 解析前执行)，避免登录后头像闪烁 ─────────
   原理：直接读 localStorage 的 Supabase session token，无需等 supabase-js 加载。
   读到就立即给 <html> 加 .is-authed class，CSS 会把 #loginBtn 即刻渲染成头像占位。
   wireUserMenu() 异步 ready 后再做真正的 DOM 替换 + 下拉绑定 (用户视觉上无缝)。 */
(function () {
  try {
    var raw = localStorage.getItem('sb-kyiqgvxvbxktiygohuqh-auth-token');
    if (!raw) return;
    var data = JSON.parse(raw);
    var session = data && data.access_token ? data
                : data && data.currentSession ? data.currentSession
                : Array.isArray(data) ? data[0]
                : null;
    if (!session || !session.user || !session.user.email) return;
    var email   = session.user.email;
    var handle  = email.split('@')[0] || 'user';
    var initial = (handle.charAt(0) || 'U').toUpperCase();
    window.__moxiePreloadUser = { email: email, handle: handle, initial: initial };
    document.documentElement.classList.add('is-authed');
    document.documentElement.style.setProperty('--moxie-user-initial', JSON.stringify(initial));
  } catch (_) {}
})();

/* 通过 CDN 加载 supabase-js v2 */
(function () {
  if (window.supabase) { init(); return; }
  var s = document.createElement('script');
  /* 自托管(同源)替换被墙/极慢的 jsdelivr;npmmirror 禁代理此包,故落本地 public/vendor */
  s.src = '/public/vendor/supabase.min.js';
  s.onload = init;
  document.head.appendChild(s);

  function init() {
    if (!window.supabase) {
      console.error('[MOXIE] supabase-js failed to load');
      return;
    }
    if (MOXIE_SUPABASE_URL.indexOf('YOUR-PROJECT') !== -1) {
      console.warn('[MOXIE] Supabase keys not configured yet — edit moxie-supabase.js');
      window.moxieDB = null;
      window.dispatchEvent(new Event('moxie-db-ready'));
      return;
    }
    var client = window.supabase.createClient(MOXIE_SUPABASE_URL, MOXIE_SUPABASE_ANON, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    window.moxieDB = client;
    window.dispatchEvent(new Event('moxie-db-ready'));
  }
})();

/* ───────── 辅助：当前用户 ───────── */
window.moxieGetUser = async function () {
  if (!window.moxieDB) return null;
  var { data } = await window.moxieDB.auth.getUser();
  return data?.user || null;
};

window.moxieIsAdmin = async function () {
  var user = await window.moxieGetUser();
  if (!user) return false;
  var { data } = await window.moxieDB
    .from('moxie_profiles')
    .select('role')
    .eq('user_id', user.id)
    .single();
  return data?.role === 'admin';
};

/* ───────── 等待 db ready 的小工具 ───────── */
window.moxieWhenDBReady = function (cb) {
  if (window.moxieDB !== undefined) { cb(window.moxieDB); return; }
  window.addEventListener('moxie-db-ready', function () { cb(window.moxieDB); }, { once: true });
};

/* ═════════════════════════════════════════════
   MoxieDB · 公开站统一数据访问层
   所有公开页 fetch 数据走这里，方便后续换接口
   ═════════════════════════════════════════════ */
window.MoxieDB = {
  /* ---------- 产品 ---------- */
  async products(opts) {
    opts = opts || {};
    if (!window.moxieDB) return { data: [], error: 'db-not-ready' };
    let q = window.moxieDB.from('moxie_products')
      .select('*, moxie_categories(id, name, slug, group_name)')
      .eq('status', 'published');
    if (opts.categorySlug) {
      const { data: cat } = await window.moxieDB
        .from('moxie_categories').select('id').eq('slug', opts.categorySlug).single();
      if (cat) q = q.eq('category_id', cat.id);
    }
    if (opts.categoryIds) q = q.in('category_id', opts.categoryIds);
    if (opts.featured) q = q.eq('featured', true);
    q = q.order(opts.orderBy || 'weight_score', { ascending: false })
         .limit(opts.limit || 24);
    return await q;
  },
  async productBySlug(slug) {
    if (!window.moxieDB) return { data: null, error: 'db-not-ready' };
    return await window.moxieDB.from('moxie_products')
      .select('*, moxie_categories(name, slug, group_name)')
      .eq('slug', slug).maybeSingle();
  },
  async searchProducts(q, opts) {
    opts = opts || {};
    if (!window.moxieDB) return { data: [], error: 'db-not-ready' };
    const term = String(q || '').trim();
    if (!term) return { data: [], error: null };
    const esc = term.replace(/[%,()]/g, ' ');
    const like = `%${esc}%`;
    let query = window.moxieDB.from('moxie_products')
      .select('*, moxie_categories(id, name, slug, group_name)')
      .eq('status', 'published')
      .or(`name.ilike.${like},tagline.ilike.${like},slug.ilike.${like},domain.ilike.${like}`)
      .order('vote_count', { ascending: false })
      .limit(opts.limit || 24);
    return await query;
  },
  async productsCount(filter) {
    if (!window.moxieDB) return 0;
    let q = window.moxieDB.from('moxie_products')
      .select('id', { count: 'exact', head: true }).eq('status', 'published');
    if (filter?.featured) q = q.eq('featured', true);
    const { count } = await q;
    return count || 0;
  },

  /* ---------- 分类 ---------- */
  async categories() {
    if (!window.moxieDB) return { data: [], error: 'db-not-ready' };
    return await window.moxieDB.from('moxie_categories')
      .select('*').order('sort_order', { ascending: true });
  },

  /* ---------- 文章 ---------- */
  async articles(opts) {
    opts = opts || {};
    if (!window.moxieDB) return { data: [], error: 'db-not-ready' };
    let q = window.moxieDB.from('moxie_articles').select('*').eq('status', 'published');
    if (opts.category) q = q.eq('category', opts.category);
    q = q.order('published_at', { ascending: false }).limit(opts.limit || 30);
    return await q;
  },
  async articleBySlug(slug) {
    if (!window.moxieDB) return { data: null, error: 'db-not-ready' };
    return await window.moxieDB.from('moxie_articles')
      .select('*').eq('slug', slug).maybeSingle();
  },

  /* ---------- 每日 AI 快讯(cron 拉 RSS 写入)---------- */
  async news(opts) {
    opts = opts || {};
    if (!window.moxieDB) return { data: [], error: 'db-not-ready' };
    return await window.moxieDB.from('moxie_news')
      .select('id,title,url,source,tag,published_at,summary')
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(opts.limit || 8);
  },
  async newsById(id) {
    if (!window.moxieDB) return { data: null, error: 'db-not-ready' };
    return await window.moxieDB.from('moxie_news')
      .select('id,title,url,source,tag,published_at,summary').eq('id', id).maybeSingle();
  },

  /* ---------- AI 业界热议(名人观点,evergreen + 每日抽取)---------- */
  async voices(opts) {
    opts = opts || {};
    if (!window.moxieDB) return { data: [], error: 'db-not-ready' };
    return await window.moxieDB.from('moxie_voices')
      .select('person,role,take,importance,news_id,published_at')
      .order('importance', { ascending: false })
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(opts.limit || 5);
  },

  /* ---------- 评论 ---------- */
  async commentsFor(targetType, targetId) {
    if (!window.moxieDB) return { data: [], error: 'db-not-ready' };
    return await window.moxieDB.from('moxie_comments')
      .select('*, moxie_profiles(display_name, avatar_url)')
      .eq('target_type', targetType).eq('target_id', targetId)
      .eq('status', 'visible')
      .order('created_at', { ascending: false });
  },
  async postComment(targetType, targetId, body) {
    if (!window.moxieDB) return { error: 'db-not-ready' };
    const { data: { user } } = await window.moxieDB.auth.getUser();
    if (!user) return { error: 'not-logged-in' };
    return await window.moxieDB.from('moxie_comments').insert({
      target_type: targetType, target_id: targetId, user_id: user.id, body
    }).select().single();
  },

  /* ---------- 投票 ---------- */
  async voteCheck(productId) {
    if (!window.moxieDB) return false;
    const { data: { user } } = await window.moxieDB.auth.getUser();
    if (!user) return false;
    const { data } = await window.moxieDB.from('moxie_votes')
      .select('id').eq('product_id', productId).eq('user_id', user.id).maybeSingle();
    return !!data;
  },
  async voteToggle(productId) {
    if (!window.moxieDB) return { error: 'db-not-ready' };
    const { data: { user } } = await window.moxieDB.auth.getUser();
    if (!user) return { error: 'not-logged-in' };
    const { data: existing } = await window.moxieDB.from('moxie_votes')
      .select('id').eq('product_id', productId).eq('user_id', user.id).maybeSingle();
    if (existing) {
      await window.moxieDB.from('moxie_votes').delete().eq('id', existing.id);
      return { voted: false };
    } else {
      await window.moxieDB.from('moxie_votes').insert({ product_id: productId, user_id: user.id });
      return { voted: true };
    }
  },

  /* ---------- 提交产品 ---------- */
  async submitProduct(payload) {
    if (!window.moxieDB) return { error: 'db-not-ready' };
    const { data: { user } } = await window.moxieDB.auth.getUser();
    if (!user) return { error: 'not-logged-in' };
    return await window.moxieDB.from('moxie_products').insert({
      ...payload,
      status: 'pending',
      submitted_by: user.id
    }).select().single();
  }
};
