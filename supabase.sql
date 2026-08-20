-- Doomi upbo notebook - run once in Supabase SQL Editor.
-- Create the admin account first (Authentication > Users > Add user),
-- otherwise the write policies below lock you out of your own admin page.

create table if not exists public.debts (
  id              bigint generated always as identity primary key,
  nickname        text        not null,
  soop_id         text        not null,
  description     text        not null,
  status          text        not null default 'active',
  source          text        not null default 'manual',
  category        text        not null default 'roulette',
  source_event_id text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint debts_status_check check (status in ('active', 'done')),
  constraint debts_source_check check (source in ('manual', 'weplab')),
  -- Change the list here and in CATEGORIES (public.js) and admin.js together.
  constraint debts_category_check check (category in ('roulette', 'promise', 'event')),
  constraint debts_nickname_len check (char_length(nickname) between 1 and 80),
  constraint debts_soop_id_len check (char_length(soop_id) between 1 and 80),
  constraint debts_description_len check (char_length(description) between 1 and 1000)
);

-- Roulette dedup key: event_uid + stage. Manual rows leave it null and
-- Postgres treats each null as distinct, so many manual rows are fine.
-- Must stay a plain (non-partial) unique index: the import API relies on
-- ON CONFLICT inference, which cannot target a partial index.
create unique index if not exists debts_source_event_id_key
  on public.debts (source_event_id);

create index if not exists debts_created_at_idx on public.debts (created_at desc);
create index if not exists debts_status_idx on public.debts (status);
create index if not exists debts_category_idx on public.debts (category);

-- Already have a debts table from an earlier version? Run this one line instead
-- of recreating it, then continue from the policies below.
--   alter table public.debts
--     add column if not exists category text not null default 'roulette';
--   alter table public.debts drop constraint if exists debts_category_check;
--   alter table public.debts add constraint debts_category_check
--     check (category in ('roulette', 'promise', 'event'));

alter table public.debts enable row level security;

drop policy if exists debts_read_all on public.debts;
drop policy if exists debts_insert_admin on public.debts;
drop policy if exists debts_update_admin on public.debts;
drop policy if exists debts_delete_admin on public.debts;

create policy debts_read_all
  on public.debts for select
  to anon, authenticated
  using (true);

create policy debts_insert_admin
  on public.debts for insert
  to authenticated
  with check (true);

create policy debts_update_admin
  on public.debts for update
  to authenticated
  using (true)
  with check (true);

create policy debts_delete_admin
  on public.debts for delete
  to authenticated
  using (true);

-- completed_at follows status without the client having to send it.
create or replace function public.debts_sync_completed_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'done' then
    new.completed_at := coalesce(new.completed_at, now());
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists debts_completed_at on public.debts;
create trigger debts_completed_at
  before insert or update on public.debts
  for each row execute function public.debts_sync_completed_at();
