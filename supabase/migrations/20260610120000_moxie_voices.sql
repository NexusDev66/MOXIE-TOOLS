-- AI 业界热议:名人对 AI 的观点/疑问。evergreen 种子打底 + 每日从快讯自动抽取。
create table if not exists moxie_voices (
  id           bigint generated always as identity primary key,
  person       text not null,                 -- 人物
  role         text,                           -- 身份
  take         text not null,                  -- 观点/疑问(忠实转述,不编造)
  importance   int  not null default 3,        -- 重要度 1..5(排序用)
  news_id      bigint,                         -- 来源快讯(可空;evergreen 种子为空)
  published_at timestamptz,                    -- 来源/发表时间(排序用)
  created_at   timestamptz not null default now(),
  unique (person, take)                        -- 去重
);

create index if not exists idx_moxie_voices_sort on moxie_voices (importance desc, published_at desc nulls last);

alter table moxie_voices enable row level security;
drop policy if exists voices_read_public on moxie_voices;
create policy voices_read_public on moxie_voices for select using (true);
