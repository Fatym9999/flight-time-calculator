-- Historical transactional checks, recovered 2026-10-11. See README.md before use.
-- Creates fixtures in auth.users; do not run automatically on the shared database.
-- Fixtures and test records are rolled back, including on assertion failure.
begin;
do $$
declare first_id uuid := gen_random_uuid(); second_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values (first_id), (second_id);
  perform set_config('test.owner_one', first_id::text, true);
  perform set_config('test.owner_two', second_id::text, true);
  perform set_config('request.jwt.claim.sub', first_id::text, true);
end;
$$;
set local role authenticated;
do $$
declare first_save jsonb; repeat_save jsonb; token uuid := gen_random_uuid();
begin
  first_save := public.save_flight_journal('[{"min":75,"appr":2,"land":1,"label":"Тест"}]', 0, token, current_setting('test.owner_one')::uuid);
  if (first_save ->> 'revision')::integer <> 1 then raise exception 'FAIL first save'; end if;
  repeat_save := public.save_flight_journal('[{"min":75,"appr":2,"land":1,"label":"Тест"}]', 0, token, current_setting('test.owner_one')::uuid);
  if first_save <> repeat_save then raise exception 'FAIL idempotency'; end if;
  perform public.save_flight_journal('[]', 1, gen_random_uuid(), current_setting('test.owner_one')::uuid);
  begin
    perform public.save_flight_journal('[]', 1, gen_random_uuid(), current_setting('test.owner_one')::uuid);
    raise exception 'FAIL stale write accepted';
  exception when serialization_failure then null;
  end;
  begin
    perform public.save_flight_journal('[{"min":-1,"appr":0,"land":0,"label":""}]', 2, gen_random_uuid(), current_setting('test.owner_one')::uuid);
    raise exception 'FAIL invalid entry accepted';
  exception when check_violation then null;
  end;
  if (select revision from public.flight_journals) <> 2 then raise exception 'FAIL atomicity'; end if;
end;
$$;
select set_config('request.jwt.claim.sub', current_setting('test.owner_two'), true);
do $$
declare changed integer;
begin
  if exists (select 1 from public.flight_journals) then raise exception 'FAIL cross-user read'; end if;
  update public.flight_journals set entries = '[]' where user_id = current_setting('test.owner_one')::uuid;
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'FAIL cross-user update'; end if;
  begin
    insert into public.flight_journals(user_id, entries, mutation_id)
      values (current_setting('test.owner_one')::uuid, '[]', gen_random_uuid());
    raise exception 'FAIL cross-user insert';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.flight_journals;
    raise exception 'FAIL direct delete allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
set local role anon;
do $$
begin
  begin
    perform 1 from public.flight_journals;
    raise exception 'FAIL signed-out read allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_flight_journal('[]', 0, gen_random_uuid(), current_setting('test.owner_one')::uuid);
    raise exception 'FAIL signed-out save allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;
select 'OK: revision checks, idempotency, validation and account isolation passed; test data rolled back' as result;
