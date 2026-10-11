-- Historical initial schema, recovered 2026-10-11. See README.md before use.
-- This is not a migration and must not be rerun on the existing shared database.
-- This adds an empty cloud journal; it never imports browser data.
begin;

create or replace function public.valid_flight_entries(value jsonb)
returns boolean language plpgsql immutable security invoker
set search_path = '' as $$
declare entry jsonb; field text; number_value numeric;
begin
  if value is null or jsonb_typeof(value) <> 'array' then return false; end if;
  if jsonb_array_length(value) > 10000 then return false; end if;
  for entry in select jsonb_array_elements(value) loop
    if jsonb_typeof(entry) <> 'object' then return false; end if;
    foreach field in array array['min', 'appr', 'land'] loop
      if jsonb_typeof(entry -> field) is distinct from 'number' then return false; end if;
      number_value := (entry ->> field)::numeric;
      if number_value < 0 or number_value > 1000000000 or trunc(number_value) <> number_value then return false; end if;
    end loop;
    if jsonb_typeof(entry -> 'label') is distinct from 'string'
      or length(entry ->> 'label') > 40 then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function public.valid_flight_entries(jsonb) from public, anon;
grant execute on function public.valid_flight_entries(jsonb) to authenticated;

create table public.flight_journals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  entries jsonb not null default '[]'::jsonb check (public.valid_flight_entries(entries)),
  revision integer not null default 1 check (revision > 0),
  mutation_id uuid not null,
  updated_at timestamptz not null default now()
);
alter table public.flight_journals enable row level security;
revoke all on public.flight_journals from public, anon, authenticated;
grant select, insert, update on public.flight_journals to authenticated;

create policy journal_read on public.flight_journals for select to authenticated
  using ((select auth.uid()) = user_id);
create policy journal_insert on public.flight_journals for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy journal_update on public.flight_journals for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Compare revisions inside one transaction. A stale device cannot overwrite a newer journal.
-- Retrying the same request_id is idempotent, including after an ambiguous network failure.
create or replace function public.save_flight_journal(
  new_entries jsonb, expected_revision integer, request_id uuid, expected_owner uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare owner_id uuid := auth.uid(); saved public.flight_journals;
begin
  if owner_id is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if expected_owner is distinct from owner_id then raise exception 'Account changed' using errcode = '42501'; end if;
  if request_id is null or expected_revision < 0 or expected_revision is null then
    raise exception 'Invalid revision or request' using errcode = '22023';
  end if;
  select * into saved from public.flight_journals
    where user_id = owner_id and mutation_id = request_id;
  if found then return to_jsonb(saved); end if;

  if expected_revision = 0 then
    insert into public.flight_journals(user_id, entries, revision, mutation_id)
      values (owner_id, new_entries, 1, request_id)
      on conflict (user_id) do nothing returning * into saved;
  else
    update public.flight_journals set entries = new_entries, revision = revision + 1,
      mutation_id = request_id, updated_at = now()
      where user_id = owner_id and revision = expected_revision returning * into saved;
  end if;
  if not found then
    select * into saved from public.flight_journals
      where user_id = owner_id and mutation_id = request_id;
    if not found then raise exception 'Journal changed on another device' using errcode = '40001'; end if;
  end if;
  return to_jsonb(saved);
end;
$$;
revoke all on function public.save_flight_journal(jsonb, integer, uuid, uuid) from public, anon;
grant execute on function public.save_flight_journal(jsonb, integer, uuid, uuid) to authenticated;
commit;
