-- ========================================
-- MOXIE Schema · Migration 001 · Initial
-- 在 Supabase SQL Editor 里整段粘贴跑一次
-- ========================================

-- ---------- 1. categories ----------
create table moxie_categories (
  id bigserial primary key,
  slug text not null unique,
  name text not null,
  group_name text not null,       -- 'aigc' / 'platform' / 'devtool'
  description text,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- ---------- 2. products ----------
create table moxie_products (
  id bigserial primary key,
  slug text not null unique,
  name text not null,
  domain text not null,           -- 用来抓 favicon 和拼访问 URL
  tagline text not null,          -- 一句话描述（卡片用）
  description text,               -- 详细介绍（详情页用）
  category_id bigint references moxie_categories(id) on delete set null,
  tags text[] default '{}',
  price_label text default '免费', -- '免费' / '¥29/月' / '按量' 等
  domestic_available text default 'yes',  -- yes / partial / no
  data_overseas boolean default false,
  verified boolean default false, -- '子墨测过'
  featured boolean default false, -- 当周精选
  vote_count int default 0,
  status text default 'published', -- draft / pending / published / archived
  submitted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index on moxie_products (category_id);
create index on moxie_products (status);
create index on moxie_products using gin (tags);

-- ---------- 3. articles ----------
create table moxie_articles (
  id bigserial primary key,
  slug text not null unique,
  title text not null,
  excerpt text,
  cover_url text,
  body_html text,                 -- 富文本 HTML
  category text default '横评',    -- 横评 / 手册 / 增长 / 选型
  read_minutes int default 5,
  author_id uuid references auth.users(id) on delete set null,
  related_product_ids bigint[] default '{}',
  status text default 'published',
  published_at timestamptz default now(),
  created_at timestamptz default now()
);
create index on moxie_articles (status);

-- ---------- 4. comments ----------
create table moxie_comments (
  id bigserial primary key,
  target_type text not null,      -- 'product' / 'article'
  target_id bigint not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  body text not null,
  status text default 'visible',  -- visible / hidden / pending
  created_at timestamptz default now()
);
create index on moxie_comments (target_type, target_id);

-- ---------- 5. votes ----------
create table moxie_votes (
  id bigserial primary key,
  product_id bigint references moxie_products(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  created_at timestamptz default now(),
  unique (product_id, user_id)
);

-- ---------- 6. user profiles (扩展 auth.users) ----------
create table moxie_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  role text default 'user',       -- 'user' / 'admin'
  bio text,
  github_handle text,
  created_at timestamptz default now()
);

-- 当 auth.users 新增用户时自动建一行 moxie_profiles
create or replace function moxie_handle_new_user()
returns trigger as $$
begin
  insert into moxie_profiles (user_id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger moxie_on_auth_user_created
after insert on auth.users
for each row execute function moxie_handle_new_user();

-- ---------- 7. 自动维护 vote_count ----------
create or replace function moxie_recount_votes()
returns trigger as $$
begin
  update moxie_products
    set vote_count = (select count(*) from moxie_votes where product_id = coalesce(new.product_id, old.product_id))
    where id = coalesce(new.product_id, old.product_id);
  return null;
end;
$$ language plpgsql;

create trigger moxie_votes_after_change
after insert or delete on moxie_votes
for each row execute function moxie_recount_votes();

-- ========================================
-- RLS Policies
-- ========================================
alter table moxie_categories enable row level security;
alter table moxie_products   enable row level security;
alter table moxie_articles   enable row level security;
alter table moxie_comments   enable row level security;
alter table moxie_votes      enable row level security;
alter table moxie_profiles   enable row level security;

-- 帮助函数：当前用户是否 admin
create or replace function moxie_is_admin()
returns boolean as $$
  select exists (
    select 1 from moxie_profiles
    where user_id = auth.uid() and role = 'admin'
  );
$$ language sql stable;

-- categories：所有人可读，admin 可写
create policy "cats_read"  on moxie_categories for select using (true);
create policy "cats_write" on moxie_categories for all    using (moxie_is_admin()) with check (moxie_is_admin());

-- products：所有人可读已发布 + 自己提交的所有状态，admin 可读全部 + 写
create policy "prod_read_public" on moxie_products for select using (status = 'published' or moxie_is_admin() or submitted_by = auth.uid());
create policy "prod_insert" on moxie_products for insert with check (auth.uid() is not null);
create policy "prod_admin_write" on moxie_products for update using (moxie_is_admin()) with check (moxie_is_admin());
create policy "prod_admin_delete" on moxie_products for delete using (moxie_is_admin());

-- articles：所有人可读已发布，admin 可写
create policy "art_read"  on moxie_articles for select using (status = 'published' or moxie_is_admin());
create policy "art_write" on moxie_articles for all    using (moxie_is_admin()) with check (moxie_is_admin());

-- comments：所有人可读 visible 的，登录可发，admin/作者可删
create policy "com_read"   on moxie_comments for select using (status = 'visible' or moxie_is_admin() or user_id = auth.uid());
create policy "com_insert" on moxie_comments for insert with check (auth.uid() = user_id);
create policy "com_update" on moxie_comments for update using (moxie_is_admin() or user_id = auth.uid()) with check (moxie_is_admin() or user_id = auth.uid());
create policy "com_delete" on moxie_comments for delete using (moxie_is_admin() or user_id = auth.uid());

-- votes：登录可投/删自己的
create policy "vote_read"   on moxie_votes for select using (true);
create policy "vote_insert" on moxie_votes for insert with check (auth.uid() = user_id);
create policy "vote_delete" on moxie_votes for delete using (auth.uid() = user_id);

-- profiles：所有人可读，本人可改自己（除 role），admin 可改 role
create policy "prof_read"   on moxie_profiles for select using (true);
create policy "prof_update_self" on moxie_profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid() and role = (select role from moxie_profiles where user_id = auth.uid()));
create policy "prof_admin_all"   on moxie_profiles for all    using (moxie_is_admin()) with check (moxie_is_admin());

-- ========================================
-- Seed Data · 从当前硬编码的内容里抽 12 个种子
-- ========================================
insert into moxie_categories (slug, name, group_name, description, sort_order) values
  ('llm',          '大模型',         'platform', '国产 + 海外 LLM API', 1),
  ('ai-assistant', 'AI 助手',        'platform', '通用对话型 AI', 2),
  ('ai-writing',   'AI 写作',        'aigc',     '公众号 / 小红书 / SEO', 3),
  ('ai-image',     'AI 图像',        'aigc',     '文生图 / 设计', 4),
  ('ai-video',     'AI 视频',        'aigc',     '文生视频 / 剪辑', 5),
  ('ai-coding',    'AI 编程',        'devtool',  '代码补全 / 重构', 6),
  ('ai-search',    'AI 搜索',        'devtool',  '无广告中文 AI 搜索', 7),
  ('rag',          'RAG 知识库',     'platform', '企业落地核心', 8),
  ('agent',        'AI Agent',       'platform', '自主完成任务', 9),
  ('workflow',     '工作流 / Bot',   'platform', '零代码搭建', 10);

insert into moxie_products (slug, name, domain, tagline, category_id, tags, price_label, verified, featured, vote_count, status) values
  ('deepseek-v3', 'DeepSeek V3', 'deepseek.com', '国产开源大模型，推理能力对标 GPT-4o，输出价格仅 1/10', (select id from moxie_categories where slug='llm'), array['大模型','开源'], '按量', true, true, 847, 'published'),
  ('kimi',        'Kimi',        'kimi.com',     '月之暗面，长上下文之王，200 万字 PDF 秒读',                (select id from moxie_categories where slug='ai-assistant'), array['助手','长文档'], '免费', true, false, 612, 'published'),
  ('cursor',      'Cursor',      'cursor.com',   'AI 原生 IDE，Claude / GPT 双引擎，代码理解到位',           (select id from moxie_categories where slug='ai-coding'), array['编程','IDE'], '$20/月', true, true, 593, 'published'),
  ('jimeng',      '即梦',        'jimeng.jianying.com', '字节文生图 + 文生视频，国内最稳的 AIGC 入口',     (select id from moxie_categories where slug='ai-image'), array['图像','视频'], '免费', true, false, 478, 'published'),
  ('mita',        '秘塔搜索',    'metaso.cn',    '无广告中文 AI 搜索，学术 / 调研专用',                       (select id from moxie_categories where slug='ai-search'), array['搜索','学术'], '免费', true, false, 421, 'published'),
  ('coze',        'Coze',        'coze.cn',      '字节零代码 AI Bot 平台，国内首选 Agent 构建',               (select id from moxie_categories where slug='workflow'), array['Bot','Agent'], '免费', true, false, 389, 'published'),
  ('zhipu',       '智谱清言',    'chatglm.cn',   'GLM-4 加持的中文通用助手，免费额度大方',                    (select id from moxie_categories where slug='ai-assistant'), array['助手','国产'], '免费', false, false, 312, 'published'),
  ('dify',        'Dify',        'dify.ai',      '开源 LLMOps，本地化部署的 RAG / Agent 一站式',              (select id from moxie_categories where slug='rag'), array['RAG','开源'], '免费 + 企业', false, false, 287, 'published'),
  ('manus',       'Manus',       'manus.im',     '通用 AI Agent，浏览器 + 终端操作打底',                      (select id from moxie_categories where slug='agent'), array['Agent','通用'], '邀请制', false, false, 254, 'published'),
  ('trae',        'Trae',        'trae.ai',      '字节版 Cursor，国内可用，Claude 模型直连',                  (select id from moxie_categories where slug='ai-coding'), array['编程','国产'], '免费', true, false, 231, 'published'),
  ('biling',      '笔灵',        'biling.cn',    '公众号 / 小红书爆款标题 + 长文生成',                        (select id from moxie_categories where slug='ai-writing'), array['写作','营销'], '¥29/月', false, false, 198, 'published'),
  ('hailuo',      '海螺',        'hailuoai.com', 'MiniMax 文生视频，6 秒高质量，物理感最强',                  (select id from moxie_categories where slug='ai-video'), array['视频','国产'], '免费 + 按量', true, false, 176, 'published');

insert into moxie_articles (slug, title, excerpt, category, read_minutes, status) values
  ('deepseek-v3-vs-claude',   'DeepSeek V3 中文实测：3 个 Claude 没有的优势',           '我用 DeepSeek V3 替换 Claude 跑了 30 天我所有的中文写作 / 代码 / 推理任务，结论比预期意外。', '横评', 8, 'published'),
  ('cursor-trae-windsurf',    'Cursor vs Trae vs Windsurf：4 万行项目实测', '同一个 4 万行的 Next.js 项目，三个 AI IDE 各跑两周，哪个真能帮你顶 P0。', '横评', 12, 'published'),
  ('ai-content-saas-playbook', 'AI 内容 SaaS 从 0 到 10 万 MRR 的 7 个动作',           '把 10 个真实出海 maker 的早期增长路径抽出共性，能直接抄。', '增长', 10, 'published'),
  ('rag-vendor-selection-2026', '2026 中文企业 RAG 选型：12 款产品 vs 3 个真实场景',  '把市面上的 12 款 RAG 工具按法务 / 客服 / 研发三个真实场景跑了一遍。', '选型', 15, 'published');

-- ========================================
-- 完成。下一步：
-- 1) 在 Supabase Dashboard → Authentication → Providers 启用 GitHub + Google
-- 2) 注册一个邮箱，登录后在 SQL Editor 跑：
--    update moxie_profiles set role='admin' where user_id = (select id from auth.users where email='你的邮箱');
-- 3) 把项目的 URL 和 anon key 填到 moxie-supabase.js
-- ========================================
