-- 每日 AI 快讯热闻:cron 拉 RSS 写入,首页客户端 anon 读
create table if not exists moxie_news (
  id           bigint generated always as identity primary key,
  title        text not null,
  url          text not null unique,           -- 去重键
  source       text,                           -- 来源(如 机器之心 / 量子位 / Solidot)
  tag          text,                           -- 小标签(暂用来源名)
  published_at timestamptz,                    -- 原文发布时间
  created_at   timestamptz not null default now()
);

create index if not exists idx_moxie_news_published on moxie_news (published_at desc nulls last);

alter table moxie_news enable row level security;

-- 公开可读(快讯本就是公开新闻);写入靠 service key(绕过 RLS)
drop policy if exists news_read_public on moxie_news;
create policy news_read_public on moxie_news for select using (true);
