-- Apply only to the Supabase project used by the customer portal.
-- Stores an immutable, account-authenticated electronic acceptance record.

create table if not exists public.client_document_signatures (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.project_documents(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  signer_name text not null check (char_length(trim(signer_name)) between 2 and 180),
  signer_email text not null,
  document_title text not null,
  document_file_name text not null,
  document_sha256 char(64) not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  consent_text text not null check (char_length(trim(consent_text)) between 20 and 1000),
  signed_at timestamptz not null default now(),
  user_agent text not null default '',
  unique (document_id, user_id)
);

create index if not exists client_document_signatures_user_project_idx
  on public.client_document_signatures (user_id, project_id, signed_at desc);

create or replace function public.prevent_client_signature_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Assinaturas registradas não podem ser alteradas ou apagadas.'
    using errcode = '42501';
end;
$$;

drop trigger if exists client_document_signatures_immutable on public.client_document_signatures;
create trigger client_document_signatures_immutable
  before update or delete on public.client_document_signatures
  for each row execute function public.prevent_client_signature_mutation();

revoke all on function public.prevent_client_signature_mutation() from public, anon, authenticated;

alter table public.client_document_signatures enable row level security;
revoke all on public.client_document_signatures from anon, authenticated;
grant select on public.client_document_signatures to authenticated;

drop policy if exists "clients read own document signatures" on public.client_document_signatures;
create policy "clients read own document signatures"
  on public.client_document_signatures for select to authenticated
  using (user_id = (select auth.uid()));
