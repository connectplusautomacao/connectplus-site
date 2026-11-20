-- Connect Plus Gestão Interna
-- Execute APENAS no projeto Supabase exclusivo da plataforma interna.
-- A tabela guarda um estado JSON da plataforma; RLS limita leitura/gravação
-- a contas da equipe cadastradas como ativas em company_members.

create table if not exists public.company_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'technician')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.internal_app_state (
  id text primary key check (id = 'connectplus'),
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.company_members enable row level security;
alter table public.internal_app_state enable row level security;

create or replace function public.is_active_company_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.company_members m
    where m.user_id = (select auth.uid()) and m.active = true
      and m.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_active_company_member() from public;
grant execute on function public.is_active_company_member() to authenticated;

drop policy if exists "members can read their own membership" on public.company_members;
create policy "members can read their own membership"
  on public.company_members for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "authorized staff read internal state" on public.internal_app_state;
create policy "authorized staff read internal state"
  on public.internal_app_state for select to authenticated
  using ((select public.is_active_company_member()));

drop policy if exists "authorized staff create internal state" on public.internal_app_state;
create policy "authorized staff create internal state"
  on public.internal_app_state for insert to authenticated
  with check ((select public.is_active_company_member()));

drop policy if exists "authorized staff update internal state" on public.internal_app_state;
create policy "authorized staff update internal state"
  on public.internal_app_state for update to authenticated
  using ((select public.is_active_company_member()))
  with check ((select public.is_active_company_member()));

revoke all on public.company_members from anon, authenticated;
grant select on public.company_members to authenticated;
revoke all on public.internal_app_state from anon, authenticated;
grant select, insert, update on public.internal_app_state to authenticated;

-- Libera o usuário proprietário depois que ele já tiver sido criado em
-- Authentication > Users. Troque o e-mail se a conta proprietária for outra.
insert into public.company_members (user_id, email, role, active)
select id, lower(email), 'owner', true
from auth.users
where lower(email) = 'connectplusautomacao26@gmail.com'
on conflict (user_id) do update
set email = excluded.email, role = 'owner', active = true;

-- Verificação: deve retornar uma linha com role=owner.
select email, role, active from public.company_members
where lower(email) = 'connectplusautomacao26@gmail.com';
