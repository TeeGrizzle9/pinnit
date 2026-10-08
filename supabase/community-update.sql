-- =====================================================================
-- Pinnit community update
-- Run once in Supabase > SQL Editor, after your original setup.sql.
-- Safe to run again: everything is "if not exists" or replaced.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Events: open activity list, category, accessibility, noise level
-- ---------------------------------------------------------------------

-- The sports version may have limited events.activity to a fixed list.
-- Drop any such check and allow any short lowercase id instead.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.events'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%activity%'
  loop
    execute format('alter table public.events drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.events add constraint events_activity_check check (activity ~ '^[a-z_]{2,24}$');

alter table public.events add column if not exists category text;
alter table public.events add column if not exists access text[];
alter table public.events add column if not exists noise_level text;

alter table public.events drop constraint if exists events_category_check;
alter table public.events add constraint events_category_check
  check (category is null or category in ('sport','move','arts','music','games','outdoors','wellbeing','social'));

alter table public.events drop constraint if exists events_noise_check;
alter table public.events add constraint events_noise_check
  check (noise_level is null or noise_level in ('quiet','moderate','loud'));

alter table public.events drop constraint if exists events_access_check;
alter table public.events add constraint events_access_check
  check (access is null or access <@ array['wheelchair','step_free','toilet','seating','shade','transport','parking','auslan',
                                           'newcomers','sensory','kids','dogs','alcohol_free','gear']::text[]);

-- ---------------------------------------------------------------------
-- 2. Venues, community prices, manager-posted community hours
-- ---------------------------------------------------------------------
create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  kind text not null check (kind in ('pool','court','field','park','hall','school','gym','studio','library','cafe','other')),
  lat double precision not null check (lat between -34.30 and -33.30),
  lng double precision not null check (lng between 150.45 and 151.50),
  address text check (char_length(address) <= 120),
  description text check (char_length(description) <= 400),
  website text check (char_length(website) <= 200),
  access text[] not null default '{}'
    check (access <@ array['wheelchair','step_free','toilet','seating','shade','transport','parking','auslan']::text[]),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  manager_id uuid references public.profiles(id) on delete set null,
  manager_verified boolean not null default false,
  prices_checked_at timestamptz,
  prices_checked_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.venue_prices (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 60),
  price numeric(8,2) not null check (price >= 0 and price < 100000),
  unit text not null default 'entry' check (unit in ('entry','hour','session','pass','month','year')),
  note text check (char_length(note) <= 100),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  updated_by uuid default auth.uid() references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.venue_slots (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  days smallint[] not null check (cardinality(days) between 1 and 7 and days <@ array[0,1,2,3,4,5,6]::smallint[]),
  start_time time not null,
  end_time time not null,
  note text check (char_length(note) <= 120),
  posted_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

alter table public.events add column if not exists venue_id uuid references public.venues(id) on delete set null;

create index if not exists venue_prices_venue_idx on public.venue_prices(venue_id);
create index if not exists venue_slots_venue_idx on public.venue_slots(venue_id);
create index if not exists events_venue_idx on public.events(venue_id);

-- ---------------------------------------------------------------------
-- 3. Guards: people can't make themselves verified, take over someone
--    else's venue, or post prices as someone else.
--    Requests from the dashboard (no logged-in user) skip the guards,
--    which is how you verify a manager: set manager_verified = true
--    in Table Editor once you've confirmed who they are.
-- ---------------------------------------------------------------------
create or replace function public.venues_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.manager_verified := false;
    if new.manager_id is not null then new.manager_id := auth.uid(); end if;
    new.prices_checked_at := null;
    new.prices_checked_by := null;
  else
    new.created_by := old.created_by;
    new.manager_verified := old.manager_verified;
    -- only allowed manager changes: claim an unmanaged venue, or step down yourself
    if new.manager_id is distinct from old.manager_id
       and not (old.manager_id is null and new.manager_id = auth.uid())
       and not (old.manager_id = auth.uid() and new.manager_id is null) then
      new.manager_id := old.manager_id;
    end if;
    if new.manager_id is distinct from old.manager_id then new.manager_verified := false; end if;
  end if;
  return new;
end $$;
drop trigger if exists venues_guard on public.venues;
create trigger venues_guard before insert or update on public.venues
  for each row execute function public.venues_guard();

create or replace function public.venue_prices_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
    if tg_op = 'INSERT' then new.created_by := auth.uid();
    else new.created_by := old.created_by; new.venue_id := old.venue_id;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists venue_prices_stamp on public.venue_prices;
create trigger venue_prices_stamp before insert or update on public.venue_prices
  for each row execute function public.venue_prices_stamp();

create or replace function public.venue_slots_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then new.posted_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists venue_slots_stamp on public.venue_slots;
create trigger venue_slots_stamp before insert on public.venue_slots
  for each row execute function public.venue_slots_stamp();

-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
alter table public.venues enable row level security;
alter table public.venue_prices enable row level security;
alter table public.venue_slots enable row level security;

grant select, insert, update, delete on public.venues, public.venue_prices, public.venue_slots to authenticated;

-- venues: everyone signed in can see and add; the creator or manager can edit or delete
drop policy if exists venues_select on public.venues;
create policy venues_select on public.venues for select to authenticated using (true);
drop policy if exists venues_insert on public.venues;
create policy venues_insert on public.venues for insert to authenticated with check (created_by = auth.uid());
drop policy if exists venues_update on public.venues;
create policy venues_update on public.venues for update to authenticated
  using (auth.uid() = created_by or auth.uid() = manager_id) with check (true);
drop policy if exists venues_delete on public.venues;
create policy venues_delete on public.venues for delete to authenticated
  using (auth.uid() = created_by or auth.uid() = manager_id);

-- prices: community maintained, so anyone signed in can add or correct them;
-- only the person who added a price or the venue manager can remove it
drop policy if exists venue_prices_select on public.venue_prices;
create policy venue_prices_select on public.venue_prices for select to authenticated using (true);
drop policy if exists venue_prices_insert on public.venue_prices;
create policy venue_prices_insert on public.venue_prices for insert to authenticated with check (true);
drop policy if exists venue_prices_update on public.venue_prices;
create policy venue_prices_update on public.venue_prices for update to authenticated using (true) with check (true);
drop policy if exists venue_prices_delete on public.venue_prices;
create policy venue_prices_delete on public.venue_prices for delete to authenticated
  using (created_by = auth.uid()
         or exists (select 1 from public.venues v where v.id = venue_id and v.manager_id = auth.uid()));

-- community hours: only the venue's manager can post or remove them
drop policy if exists venue_slots_select on public.venue_slots;
create policy venue_slots_select on public.venue_slots for select to authenticated using (true);
drop policy if exists venue_slots_insert on public.venue_slots;
create policy venue_slots_insert on public.venue_slots for insert to authenticated
  with check (exists (select 1 from public.venues v where v.id = venue_id and v.manager_id = auth.uid()));
drop policy if exists venue_slots_delete on public.venue_slots;
create policy venue_slots_delete on public.venue_slots for delete to authenticated
  using (exists (select 1 from public.venues v where v.id = venue_id and v.manager_id = auth.uid()));

-- ---------------------------------------------------------------------
-- 5. Functions the app calls
-- ---------------------------------------------------------------------
create or replace function public.claim_venue(v uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Log in first'; end if;
  update public.venues set manager_id = auth.uid(), manager_verified = false
  where id = v and manager_id is null;
  if not found then raise exception 'This venue already has a manager'; end if;
  return true;
end $$;
revoke all on function public.claim_venue(uuid) from public, anon;
grant execute on function public.claim_venue(uuid) to authenticated;

-- "Still right" on a price list: anyone can confirm, without edit rights on the venue
create or replace function public.confirm_venue_prices(v uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Log in first'; end if;
  update public.venues set prices_checked_at = now(), prices_checked_by = auth.uid() where id = v;
end $$;
revoke all on function public.confirm_venue_prices(uuid) from public, anon;
grant execute on function public.confirm_venue_prices(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Realtime, so prices and hours update live for everyone
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['venues','venue_prices','venue_slots'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
