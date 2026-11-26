-- Separate operational information from financial and partnership data.
-- Run after 202611200001_gestao_internal.sql in the internal Supabase project.

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
      and m.role in ('owner', 'admin', 'technician')
  );
$$;

create or replace function public.is_admin_company_member()
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
revoke all on function public.is_admin_company_member() from public;
grant execute on function public.is_active_company_member() to authenticated;
grant execute on function public.is_admin_company_member() to authenticated;

-- The existing row stays private to admins and remains the source of truth
-- for all private fields. The new table contains only operational data.
drop policy if exists "authorized staff read internal state" on public.internal_app_state;
drop policy if exists "administrators read internal state" on public.internal_app_state;
create policy "administrators read internal state"
  on public.internal_app_state for select to authenticated
  using ((select public.is_admin_company_member()));

drop policy if exists "authorized staff create internal state" on public.internal_app_state;
drop policy if exists "administrators create internal state" on public.internal_app_state;
create policy "administrators create internal state"
  on public.internal_app_state for insert to authenticated
  with check ((select public.is_admin_company_member()));

drop policy if exists "authorized staff update internal state" on public.internal_app_state;
drop policy if exists "administrators update internal state" on public.internal_app_state;
create policy "administrators update internal state"
  on public.internal_app_state for update to authenticated
  using ((select public.is_admin_company_member()))
  with check ((select public.is_admin_company_member()));

create table if not exists public.team_app_state (
  id text primary key check (id = 'connectplus'),
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.team_app_state enable row level security;
revoke all on public.team_app_state from anon, authenticated;
grant select, insert, update on public.team_app_state to authenticated;

drop policy if exists "active team read operational state" on public.team_app_state;
create policy "active team read operational state"
  on public.team_app_state for select to authenticated
  using ((select public.is_active_company_member()));

drop policy if exists "active team create operational state" on public.team_app_state;
create policy "active team create operational state"
  on public.team_app_state for insert to authenticated
  with check ((select public.is_active_company_member()));

drop policy if exists "active team update operational state" on public.team_app_state;
create policy "active team update operational state"
  on public.team_app_state for update to authenticated
  using ((select public.is_active_company_member()))
  with check ((select public.is_active_company_member()));

create or replace function public.cp_strip_item_costs(items jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    case when jsonb_typeof(item.value) = 'object' then item.value - 'cost' else item.value end
    order by item.ordinality
  ), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end)
    with ordinality as item(value, ordinality);
$$;

create or replace function public.cp_strip_quote_costs(quote_data jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(quote_data) = 'object' and jsonb_typeof(quote_data->'items') = 'array'
      then jsonb_set(quote_data, '{items}', public.cp_strip_item_costs(quote_data->'items'), true)
    else coalesce(quote_data, '{}'::jsonb)
  end;
$$;

create or replace function public.cp_team_safe_state(state_data jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_set(
    jsonb_set(
      coalesce(state_data, '{}'::jsonb) - 'partners' - 'referrals' - 'financeRecords' - 'fixedCosts',
      '{quote}', public.cp_strip_quote_costs(state_data->'quote'), true
    ),
    '{savedQuotes}',
    case
      when jsonb_typeof(state_data->'savedQuotes') = 'array' then (
        select coalesce(jsonb_agg(
          case when jsonb_typeof(row_data.value->'q') = 'object'
            then jsonb_set(row_data.value, '{q}', public.cp_strip_quote_costs(row_data.value->'q'), true)
            else row_data.value end
          order by row_data.ordinality
        ), '[]'::jsonb)
        from jsonb_array_elements(state_data->'savedQuotes') with ordinality as row_data(value, ordinality)
      )
      else '[]'::jsonb
    end,
    true
  );
$$;

revoke all on function public.cp_strip_item_costs(jsonb) from public, anon, authenticated;
revoke all on function public.cp_strip_quote_costs(jsonb) from public, anon, authenticated;
revoke all on function public.cp_team_safe_state(jsonb) from public, anon, authenticated;

-- Copy the existing company data to the technician-visible table after
-- removing partner records, finance records, fixed costs and item costs.
insert into public.team_app_state (id, data, revision, updated_at)
select id, public.cp_team_safe_state(data), revision, updated_at
from public.internal_app_state
on conflict (id) do nothing;

-- Keep admin and operational saves atomic and revision-checked.
create or replace function public.save_company_app_state(
  p_admin_data jsonb,
  p_team_data jsonb,
  p_admin_revision bigint,
  p_team_revision bigint
)
returns table(admin_revision bigint, team_revision bigint)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.is_admin_company_member() then
    raise exception 'Somente administradores podem salvar os dados administrativos.' using errcode = '42501';
  end if;

  update public.internal_app_state
     set data = p_admin_data, revision = revision + 1, updated_at = now()
   where id = 'connectplus' and revision = p_admin_revision
   returning revision into admin_revision;
  if not found then
    raise exception 'Os dados privados foram alterados por outra sessão. Atualize a plataforma.' using errcode = '40001';
  end if;

  update public.team_app_state
     set data = p_team_data, revision = revision + 1, updated_at = now()
   where id = 'connectplus' and revision = p_team_revision
   returning revision into team_revision;
  if not found then
    raise exception 'Os dados da equipe foram alterados por outra sessão. Atualize a plataforma.' using errcode = '40001';
  end if;
  return next;
end;
$$;

revoke all on function public.save_company_app_state(jsonb, jsonb, bigint, bigint) from public, anon;
grant execute on function public.save_company_app_state(jsonb, jsonb, bigint, bigint) to authenticated;

-- The helper functions above are only for the migration/back-end, not client access.
drop function public.cp_strip_item_costs(jsonb);
drop function public.cp_strip_quote_costs(jsonb);
drop function public.cp_team_safe_state(jsonb);

select id, revision, updated_at from public.team_app_state where id = 'connectplus';
