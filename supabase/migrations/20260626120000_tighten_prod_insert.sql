-- 收紧 moxie_products 的 INSERT 策略(修自助发布提权漏洞)
-- ------------------------------------------------------------------
-- 原 prod_insert 只校验 `auth.uid() is not null`(登录即可),导致:
--   · 任何注册用户可绕过 REST 直接插 status='published' → 跳过审核上线;
--   · submitted_by 可填他人 id(冒充提交人)。
-- 收紧为:普通登录用户只能插「待审 + 本人提交」的行;admin 不受限(后台手动加品/直接发布)。
-- 自动管线用 service_role 写库(绕过 RLS),不受影响。

drop policy if exists "prod_insert" on moxie_products;

create policy "prod_insert" on moxie_products for insert
  with check (
    moxie_is_admin()
    or (submitted_by = auth.uid() and status = 'pending')
  );
