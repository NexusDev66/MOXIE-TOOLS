-- ========================================
-- MOXIE Migration 002 · Storage Bucket
-- 用来存文章封面 / 产品截图。
-- 跑前先在 Supabase Dashboard → Storage 创建 bucket：
--   名字: moxie-covers
--   public: ✓ 勾上（封面要公开可读）
-- 然后跑这段 SQL 加上传 policy（admin 才能上传，公开可读已自动开）
-- ========================================

create policy "moxie_covers_admin_insert"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'moxie-covers' and moxie_is_admin()
);

create policy "moxie_covers_admin_delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'moxie-covers' and moxie_is_admin()
);

create policy "moxie_covers_admin_update"
on storage.objects for update to authenticated
using (
  bucket_id = 'moxie-covers' and moxie_is_admin()
);

-- 公开读：bucket 标 public 后 Supabase 会自动给匿名读权限，
-- 但如果你没勾 public 而想自己控，跑这条：
-- create policy "moxie_covers_public_read"
-- on storage.objects for select to anon, authenticated
-- using (bucket_id = 'moxie-covers');
