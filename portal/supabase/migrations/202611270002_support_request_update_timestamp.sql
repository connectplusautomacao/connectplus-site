-- Keep a stable creation time and record subsequent support status updates.
alter table public.support_requests
  add column if not exists updated_at timestamptz;

update public.support_requests
set updated_at = created_at
where updated_at is null;

alter table public.support_requests
  alter column updated_at set default now(),
  alter column updated_at set not null;
