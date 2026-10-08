-- =====================================================================
-- Pinnit: enforce "pins only in public spaces" on the server
-- Run after community-update.sql, then deploy the place-pin Edge Function
-- straight away (until it's deployed, nobody can post new pins).
-- Safe to run again.
--
-- After this, events and venues can only be created through the place-pin
-- function, which checks the spot against OpenStreetMap first.
-- To undo the lock:  grant insert on public.events, public.venues to authenticated;
-- =====================================================================

-- cache of spot checks, so Overpass isn't asked about the same spot twice (only the function uses it)
create table if not exists public.spot_checks (
  key text primary key,
  result jsonb not null,
  checked_at timestamptz not null default now()
);
alter table public.spot_checks enable row level security;   -- no policies: only the service role can read or write
revoke all on public.spot_checks from anon, authenticated;

-- insert a row of p_row's columns (other columns keep their defaults), acting as p_user so
-- existing triggers and defaults that use auth.uid() behave exactly like a normal insert
create or replace function public._pin_insert(p_table text, p_user uuid, p_row jsonb, p_skip text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare cols text; new_id uuid;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select string_agg(quote_ident(c.column_name), ',') into cols
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = p_table
    and p_row ? c.column_name and not (c.column_name = any (p_skip));
  if cols is null then raise exception 'Nothing to insert'; end if;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning id', p_table, cols, cols, p_table)
    using p_row into new_id;
  return new_id;
end $$;
revoke all on function public._pin_insert(text, uuid, jsonb, text[]) from public, anon, authenticated;

create or replace function public.place_event(p_user uuid, p_row jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  return public._pin_insert('events', p_user, p_row || jsonb_build_object('host_id', p_user), array['id', 'created_at']);
end $$;
revoke all on function public.place_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.place_event(uuid, jsonb) to service_role;

create or replace function public.place_venue(p_user uuid, p_row jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  -- venues_guard (from community-update.sql) stamps created_by, manager and verification
  return public._pin_insert('venues', p_user, p_row,
    array['id', 'created_at', 'created_by', 'manager_verified', 'prices_checked_at', 'prices_checked_by']);
end $$;
revoke all on function public.place_venue(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.place_venue(uuid, jsonb) to service_role;

-- a checked pin can't be dragged somewhere else afterwards
create or replace function public.freeze_location() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and (new.lat is distinct from old.lat or new.lng is distinct from old.lng) then
    new.lat := old.lat; new.lng := old.lng;
  end if;
  return new;
end $$;
drop trigger if exists events_freeze_location on public.events;
create trigger events_freeze_location before update on public.events for each row execute function public.freeze_location();
drop trigger if exists venues_freeze_location on public.venues;
create trigger venues_freeze_location before update on public.venues for each row execute function public.freeze_location();

-- the lock: signed-in users can no longer insert events or venues directly
revoke insert on public.events, public.venues from anon, authenticated;
