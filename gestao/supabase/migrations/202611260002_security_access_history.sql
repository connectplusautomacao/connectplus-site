-- Harden team state writes, retain recoverable versions, and manage members.
-- Run after 202611260001_team_admin_separation.sql.

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

-- Use an allowlist so a newly added private field does not silently enter the
-- technician-visible state. Costs inside quotes are stripped separately.
create or replace function public.cp_team_safe_state(state_data jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'quote', case when jsonb_typeof(state_data->'quote') = 'object'
      then public.cp_strip_quote_costs(state_data->'quote') else '{"items":[]}'::jsonb end,
    'savedQuotes', case when jsonb_typeof(state_data->'savedQuotes') = 'array' then (
      select coalesce(jsonb_agg(
        case when jsonb_typeof(row_data.value->'q') = 'object'
          then jsonb_set(row_data.value, '{q}', public.cp_strip_quote_costs(row_data.value->'q'), true)
          else row_data.value end
        order by row_data.ordinality
      ), '[]'::jsonb)
      from jsonb_array_elements(state_data->'savedQuotes') with ordinality as row_data(value, ordinality)
    ) else '[]'::jsonb end,
    'plan', case when jsonb_typeof(state_data->'plan') = 'object' then state_data->'plan' else '{"rooms":[]}'::jsonb end,
    'visit', case when jsonb_typeof(state_data->'visit') = 'object' then state_data->'visit' else '{}'::jsonb end,
    'savedVisits', case when jsonb_typeof(state_data->'savedVisits') = 'array' then state_data->'savedVisits' else '[]'::jsonb end,
    'receipt', case when jsonb_typeof(state_data->'receipt') = 'object' then state_data->'receipt' else '{}'::jsonb end,
    'receipts', case when jsonb_typeof(state_data->'receipts') = 'array' then state_data->'receipts' else '[]'::jsonb end,
    'execution', case when jsonb_typeof(state_data->'execution') = 'object' then state_data->'execution' else '{}'::jsonb end,
    'savedExecutions', case when jsonb_typeof(state_data->'savedExecutions') = 'array' then state_data->'savedExecutions' else '[]'::jsonb end
  );
$$;

revoke all on function public.cp_strip_item_costs(jsonb) from public, anon, authenticated;
revoke all on function public.cp_strip_quote_costs(jsonb) from public, anon, authenticated;
revoke all on function public.cp_team_safe_state(jsonb) from public, anon, authenticated;

create table if not exists public.company_app_state_audit (
  id bigint generated always as identity primary key,
  area text not null check (area in ('admin', 'team')),
  actor_id uuid not null,
  actor_email text not null default '',
  changed_at timestamptz not null default now(),
  from_revision bigint not null,
  to_revision bigint not null,
  previous_data jsonb not null
);

create index if not exists company_app_state_audit_area_id_idx
  on public.company_app_state_audit (area, id desc);

alter table public.company_app_state_audit enable row level security;
revoke all on public.company_app_state_audit from anon, authenticated;
grant select on public.company_app_state_audit to authenticated;

drop policy if exists "administrators read company state history" on public.company_app_state_audit;
create policy "administrators read company state history"
  on public.company_app_state_audit for select to authenticated
  using ((select public.is_admin_company_member()));

drop policy if exists "administrators read all company members" on public.company_members;
create policy "administrators read all company members"
  on public.company_members for select to authenticated
  using ((select public.is_admin_company_member()));

-- All writes go through audited, revision-checked functions. Initial inserts
-- remain available to admins for the first backup import only.
revoke update, delete on public.internal_app_state from anon, authenticated;
grant select, insert on public.internal_app_state to authenticated;
revoke insert, update, delete on public.team_app_state from anon, authenticated;
grant select, insert on public.team_app_state to authenticated;

drop policy if exists "active team create operational state" on public.team_app_state;
drop policy if exists "administrators create operational state" on public.team_app_state;
create policy "administrators create operational state"
  on public.team_app_state for insert to authenticated
  with check ((select public.is_admin_company_member()));

create or replace function public.save_team_app_state(p_data jsonb, p_revision bigint)
returns table(team_revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
  v_data jsonb;
  v_safe_data jsonb;
  v_email text;
begin
  if not public.is_active_company_member() then
    raise exception 'Esta conta não tem acesso ativo à equipe.' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Os dados operacionais estão em formato inválido.' using errcode = '22023';
  end if;

  select m.email into v_email
    from public.company_members m
   where m.user_id = (select auth.uid()) and m.active = true;
  v_safe_data := public.cp_team_safe_state(p_data);

  select s.revision, s.data into v_revision, v_data
    from public.team_app_state s
   where s.id = 'connectplus'
   for update;
  if not found then
    raise exception 'A área da equipe ainda não foi inicializada.' using errcode = 'P0002';
  end if;
  if v_revision <> p_revision then
    raise exception 'Os dados da equipe mudaram em outra sessão. Atualize a plataforma.' using errcode = '40001';
  end if;

  insert into public.company_app_state_audit
    (area, actor_id, actor_email, from_revision, to_revision, previous_data)
  values ('team', (select auth.uid()), coalesce(v_email, ''), v_revision, v_revision + 1, v_data);

  update public.team_app_state
     set data = v_safe_data, revision = v_revision + 1, updated_at = now()
   where id = 'connectplus';

  delete from public.company_app_state_audit
   where area = 'team' and id in (
     select id from public.company_app_state_audit where area = 'team' order by id desc offset 50
   );
  return query select v_revision + 1;
end;
$$;

create or replace function public.save_company_app_state(
  p_admin_data jsonb,
  p_team_data jsonb,
  p_admin_revision bigint,
  p_team_revision bigint
)
returns table(admin_revision bigint, team_revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_revision bigint;
  v_team_revision bigint;
  v_admin_previous jsonb;
  v_team_previous jsonb;
  v_email text;
begin
  if not public.is_admin_company_member() then
    raise exception 'Somente administradores podem salvar os dados administrativos.' using errcode = '42501';
  end if;
  if p_admin_data is null or jsonb_typeof(p_admin_data) <> 'object' then
    raise exception 'Os dados administrativos estão em formato inválido.' using errcode = '22023';
  end if;

  select m.email into v_email
    from public.company_members m
   where m.user_id = (select auth.uid()) and m.active = true;
  select s.revision, s.data into v_admin_revision, v_admin_previous
    from public.internal_app_state s where s.id = 'connectplus' for update;
  if not found or v_admin_revision <> p_admin_revision then
    raise exception 'Os dados privados foram alterados por outra sessão. Atualize a plataforma.' using errcode = '40001';
  end if;
  select s.revision, s.data into v_team_revision, v_team_previous
    from public.team_app_state s where s.id = 'connectplus' for update;
  if not found or v_team_revision <> p_team_revision then
    raise exception 'Os dados da equipe foram alterados por outra sessão. Atualize a plataforma.' using errcode = '40001';
  end if;

  insert into public.company_app_state_audit
    (area, actor_id, actor_email, from_revision, to_revision, previous_data)
  values
    ('admin', (select auth.uid()), coalesce(v_email, ''), v_admin_revision, v_admin_revision + 1, v_admin_previous),
    ('team', (select auth.uid()), coalesce(v_email, ''), v_team_revision, v_team_revision + 1, v_team_previous);

  update public.internal_app_state
     set data = p_admin_data, revision = v_admin_revision + 1, updated_at = now()
   where id = 'connectplus';
  update public.team_app_state
     set data = public.cp_team_safe_state(p_team_data), revision = v_team_revision + 1, updated_at = now()
   where id = 'connectplus';

  delete from public.company_app_state_audit a
   where a.id in (
     select id from public.company_app_state_audit where area = 'admin' order by id desc offset 50
   );
  delete from public.company_app_state_audit a
   where a.id in (
     select id from public.company_app_state_audit where area = 'team' order by id desc offset 50
   );
  return query select v_admin_revision + 1, v_team_revision + 1;
end;
$$;

create or replace function public.manage_company_member_access(
  p_email text,
  p_role text,
  p_active boolean
)
returns table(email text, role text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_target_id uuid;
  v_existing_role text;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  select m.role into v_actor_role
    from public.company_members m
   where m.user_id = (select auth.uid()) and m.active = true;
  if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
    raise exception 'Somente administradores podem gerenciar acessos.' using errcode = '42501';
  end if;
  if v_email = '' or p_active is null or p_role is null or p_role not in ('technician', 'admin') then
    raise exception 'Informe um e-mail e um perfil válido.' using errcode = '22023';
  end if;
  if p_role = 'admin' and v_actor_role <> 'owner' then
    raise exception 'Somente o proprietário pode conceder perfil de administrador.' using errcode = '42501';
  end if;

  select u.id into v_target_id
    from auth.users u
   where lower(u.email) = v_email
   limit 1;
  if v_target_id is null then
    raise exception 'Crie primeiro esta conta em Supabase Authentication > Users.' using errcode = 'P0002';
  end if;
  if v_target_id = (select auth.uid()) and not p_active then
    raise exception 'Não é permitido desativar a própria conta.' using errcode = '42501';
  end if;

  select m.role into v_existing_role
    from public.company_members m
   where m.user_id = v_target_id
   for update;
  if v_existing_role = 'owner' then
    raise exception 'O acesso do proprietário não pode ser alterado por este painel.' using errcode = '42501';
  end if;
  if v_actor_role <> 'owner' and v_existing_role = 'admin' then
    raise exception 'Somente o proprietário pode alterar outro administrador.' using errcode = '42501';
  end if;

  insert into public.company_members (user_id, email, role, active)
  values (v_target_id, v_email, p_role, p_active)
  on conflict (user_id) do update
    set email = excluded.email, role = excluded.role, active = excluded.active;

  return query
    select m.email, m.role, m.active from public.company_members m where m.user_id = v_target_id;
end;
$$;

create or replace function public.restore_company_state_audit(p_audit_id bigint)
returns table(area text, revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_area text;
  v_previous jsonb;
  v_current jsonb;
  v_revision bigint;
  v_email text;
begin
  if not public.is_admin_company_member() then
    raise exception 'Somente administradores podem restaurar versões.' using errcode = '42501';
  end if;
  select a.area, a.previous_data into v_area, v_previous
    from public.company_app_state_audit a where a.id = p_audit_id;
  if not found then
    raise exception 'Esta versão não está mais disponível.' using errcode = 'P0002';
  end if;
  select m.email into v_email from public.company_members m
   where m.user_id = (select auth.uid()) and m.active = true;

  if v_area = 'admin' then
    select s.revision, s.data into v_revision, v_current
      from public.internal_app_state s where s.id = 'connectplus' for update;
    if not found then raise exception 'Dados administrativos não encontrados.' using errcode = 'P0002'; end if;
    insert into public.company_app_state_audit
      (area, actor_id, actor_email, from_revision, to_revision, previous_data)
    values ('admin', (select auth.uid()), coalesce(v_email, ''), v_revision, v_revision + 1, v_current);
    update public.internal_app_state set data = v_previous, revision = v_revision + 1, updated_at = now()
     where id = 'connectplus';
  elsif v_area = 'team' then
    select s.revision, s.data into v_revision, v_current
      from public.team_app_state s where s.id = 'connectplus' for update;
    if not found then raise exception 'Dados da equipe não encontrados.' using errcode = 'P0002'; end if;
    insert into public.company_app_state_audit
      (area, actor_id, actor_email, from_revision, to_revision, previous_data)
    values ('team', (select auth.uid()), coalesce(v_email, ''), v_revision, v_revision + 1, v_current);
    update public.team_app_state set data = public.cp_team_safe_state(v_previous), revision = v_revision + 1, updated_at = now()
     where id = 'connectplus';
  else
    raise exception 'Área de recuperação inválida.' using errcode = '22023';
  end if;

  delete from public.company_app_state_audit a
   where a.id in (
     select id from public.company_app_state_audit where area = v_area order by id desc offset 50
   );
  return query select v_area, v_revision + 1;
end;
$$;

revoke all on function public.save_team_app_state(jsonb, bigint) from public, anon;
revoke all on function public.save_company_app_state(jsonb, jsonb, bigint, bigint) from public, anon;
revoke all on function public.manage_company_member_access(text, text, boolean) from public, anon;
revoke all on function public.restore_company_state_audit(bigint) from public, anon;
grant execute on function public.save_team_app_state(jsonb, bigint) to authenticated;
grant execute on function public.save_company_app_state(jsonb, jsonb, bigint, bigint) to authenticated;
grant execute on function public.manage_company_member_access(text, text, boolean) to authenticated;
grant execute on function public.restore_company_state_audit(bigint) to authenticated;

select id, revision, updated_at from public.team_app_state where id = 'connectplus';
