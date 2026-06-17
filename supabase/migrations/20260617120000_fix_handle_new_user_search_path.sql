-- 修复:注册触发器 moxie_handle_new_user 没设 search_path,
-- 在 auth.users 插入触发时找不到未限定 schema 的 moxie_profiles,
-- 导致每次注册/建号都报 500「Database error saving new user」(沙盒 auth.users 长期 0 用户即此因)。
--
-- 与历史 20260605130000_article_jobs_touch_search_path.sql 同类问题。
-- 修法:security definer 函数固定 search_path = public,并 schema 限定表名;
-- 顺手加 on conflict do nothing,避免极端重入时报错。

create or replace function public.moxie_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.moxie_profiles (user_id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
