-- SNAFU Rally Scoring - Supabase schema
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- Safe to re-run on an empty project. To start over, run reset.sql first.
--
-- Model (one event per project):
--   riders         roster; each rider gets a secret token used in their personal link
--   bonuses        bonus list; negative points = percentage penalty (same rule as the sheet)
--   combo_members  combo code -> member bonus codes (one row per pair)
--   claims         one row per submission attempt; status pending / approved / denied
--   claim_events   audit log of every insert and status change (written by trigger)
--   scorers        email addresses allowed to use the scorer pages; is_admin also allows the admin page
--
-- Riders never log in. Every rider action goes through a function that takes
-- their token, so the anon key alone cannot read or change anything else.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table if not exists settings (
  id            int primary key default 1 check (id = 1),
  event_name    text not null default 'SNAFU Rally',
  max_attempts  int  not null default 3 check (max_attempts between 1 and 10),
  claims_open   boolean not null default true
);
insert into settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists scorers (
  email text primary key check (email = lower(email))
);
-- Admins manage the event (settings, riders, bonuses, combos, links, deletes). Scorers only review.
-- When this column is first added to an existing project, every scorer already there becomes an
-- admin, so nobody who could use the admin page before is locked out.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'scorers' and column_name = 'is_admin') then
    alter table scorers add column is_admin boolean not null default false;
    update scorers set is_admin = true;
  end if;
end $$;

create table if not exists riders (
  id            bigint generated always as identity primary key,
  rider_number  int  not null unique check (rider_number > 0),
  name          text not null check (length(trim(name)) > 0),
  email         text,
  token         uuid not null unique default gen_random_uuid(),
  created_at    timestamptz not null default now()
);
-- When the rider last opened their page (set by rider_session). Null = link never opened.
alter table riders add column if not exists last_seen_at timestamptz;

create table if not exists bonuses (
  code          text primary key
                check (code ~ '^([A-Z]{4}|[A-Z]{3}[0-9])$'),  -- 4 letters, or 3 letters + 1 digit
  name          text,
  points        int  not null,          -- negative = percent penalty, e.g. -25 cuts score by 25%
  description   text,
  sort_order    int,
  created_at    timestamptz not null default now()
);
-- Reference photo of the bonus (object path in the public "bonus-photos" bucket)
alter table bonuses add column if not exists ref_photo_path text;

create table if not exists combo_members (
  combo_code    text not null references bonuses(code) on update cascade on delete cascade,
  member_code   text not null references bonuses(code) on update cascade on delete cascade,
  primary key (combo_code, member_code),
  check (combo_code <> member_code)
);

do $$ begin
  create type claim_status as enum ('pending', 'approved', 'denied');
exception when duplicate_object then null; end $$;

create table if not exists claims (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid unique,                       -- set by the phone, makes retries safe
  rider_id      bigint not null references riders(id) on delete cascade,
  bonus_code    text   not null references bonuses(code) on update cascade,
  photo_path    text,                              -- object path in the "claims" bucket
  note          text check (length(note) <= 500),
  taken_at      timestamptz,                       -- photo file time reported by the phone
  submitted_at  timestamptz not null default now(),
  submitted_by  text not null default 'rider',     -- 'rider' or scorer email
  status        claim_status not null default 'pending',
  decided_by    text,
  decided_at    timestamptz,
  reason        text check (length(reason) <= 500)
);

-- A rider can only have each bonus approved once
create unique index if not exists claims_one_approved
  on claims (rider_id, bonus_code) where status = 'approved';
create index if not exists claims_status_idx on claims (status, submitted_at);
create index if not exists claims_rider_idx  on claims (rider_id, bonus_code);

create table if not exists claim_events (
  id            bigint generated always as identity primary key,
  claim_id      uuid not null references claims(id) on delete cascade,
  action        text not null,                     -- submitted / approved / denied / reverted
  from_status   claim_status,
  to_status     claim_status not null,
  actor         text not null,
  reason        text,
  at            timestamptz not null default now()
);
create index if not exists claim_events_claim_idx on claim_events (claim_id, at);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function current_email() returns text
language sql stable as $$
  select lower(nullif(coalesce(auth.jwt() ->> 'email', ''), ''))
$$;

create or replace function is_scorer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from scorers where email = current_email())
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from scorers where email = current_email() and is_admin)
$$;

-- What the signed-in person may do: 'admin', 'scorer' or null. Pages use it to pick what to show.
create or replace function staff_role() returns text
language sql stable security definer set search_path = public as $$
  select case when is_admin then 'admin' else 'scorer' end from scorers where email = current_email()
$$;

-- Used by the storage upload policy: the first folder of an upload path must be a real rider token
create or replace function rider_token_valid(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_token ~ '^[0-9a-fA-F-]{36}$'
     and exists (select 1 from riders where token = p_token::uuid)
$$;

create or replace function rider_from_token(p_token uuid) returns riders
language plpgsql stable security definer set search_path = public as $$
declare r riders;
begin
  select * into r from riders where token = p_token;
  if not found then
    raise exception 'This rider link is not valid. Ask the rally staff for a new one.'
      using errcode = 'P0001';
  end if;
  return r;
end $$;

create or replace function is_combo(p_code text) returns boolean
language sql stable as $$
  select exists (select 1 from combo_members where combo_code = p_code)
$$;

-- ---------------------------------------------------------------------------
-- Claim status rules + audit (applies to every write path)
-- ---------------------------------------------------------------------------
create or replace function claims_before_write() returns trigger
language plpgsql as $$
begin
  new.bonus_code := upper(trim(new.bonus_code));
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      new.decided_by := null; new.decided_at := null;
    else
      new.decided_by := coalesce(current_email(), new.submitted_by);
      new.decided_at := now();
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    -- Allowed: pending -> approved | denied, and approved | denied -> pending (revert)
    if not (old.status = 'pending' or new.status = 'pending') then
      raise exception 'Cannot change a claim from % to %. Revert it to pending first.',
        old.status, new.status using errcode = 'P0001';
    end if;
    if new.status = 'pending' then
      new.decided_by := null; new.decided_at := null;
    else
      new.decided_by := coalesce(current_email(), 'system');
      new.decided_at := now();
    end if;
  end if;

  -- Evidence is fixed once submitted
  if new.rider_id <> old.rider_id or new.bonus_code <> old.bonus_code
     or new.photo_path is distinct from old.photo_path
     or new.submitted_at <> old.submitted_at then
    raise exception 'Claim evidence cannot be edited. Deny it and add a new claim instead.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function claims_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into claim_events (claim_id, action, from_status, to_status, actor, reason)
    values (new.id, 'submitted', null, new.status, new.submitted_by, new.reason);
  elsif new.status is distinct from old.status then
    insert into claim_events (claim_id, action, from_status, to_status, actor, reason)
    values (new.id,
            case when new.status = 'pending' then 'reverted' else new.status::text end,
            old.status, new.status, coalesce(current_email(), 'system'), new.reason);
  end if;
  return null;
end $$;

drop trigger if exists claims_before_write on claims;
create trigger claims_before_write before insert or update on claims
  for each row execute function claims_before_write();
drop trigger if exists claims_after_write on claims;
create trigger claims_after_write after insert or update on claims
  for each row execute function claims_after_write();

-- ---------------------------------------------------------------------------
-- Scoring (mirrors the spreadsheet rules)
--   * a combo counts when every member bonus is approved, OR the combo itself is approved
--   * score = sum of positive points * (1 + worst approved penalty / 100)
--   * one level of combos (a combo whose member is another combo is not auto-chained)
-- ---------------------------------------------------------------------------
create or replace view approved_direct with (security_invoker = true) as
  select distinct rider_id, bonus_code from claims where status = 'approved';

create or replace view approved_effective with (security_invoker = true) as
  select rider_id, bonus_code, false as via_combo from approved_direct
  union
  select r.id, c.combo_code, true
  from riders r
  cross join (select distinct combo_code from combo_members) c
  where not exists (
          select 1 from combo_members m
          where m.combo_code = c.combo_code
            and not exists (select 1 from approved_direct a
                            where a.rider_id = r.id and a.bonus_code = m.member_code))
    and not exists (select 1 from approved_direct a
                    where a.rider_id = r.id and a.bonus_code = c.combo_code);

create or replace view rider_scores with (security_invoker = true) as
  with t as (
    select r.id as rider_id, r.rider_number, r.name,
           coalesce(sum(b.points) filter (where b.points > 0), 0)  as base_points,
           min(b.points) filter (where b.points < 0)               as worst_penalty,
           count(b.code) filter (where b.points >= 0)              as bonuses_counted
    from riders r
    left join approved_effective e on e.rider_id = r.id
    left join bonuses b on b.code = e.bonus_code
    group by r.id, r.rider_number, r.name
  )
  select t.*,
         round(base_points * (1 + coalesce(worst_penalty, 0) / 100.0), 2) as score
  from t;

create or replace view claims_detail with (security_invoker = true) as
  select c.*, r.rider_number, r.name as rider_name,
         b.name as bonus_name, b.points, is_combo(b.code) as bonus_is_combo,
         b.ref_photo_path as bonus_ref_photo
  from claims c
  join riders r on r.id = c.rider_id
  join bonuses b on b.code = c.bonus_code;

-- ---------------------------------------------------------------------------
-- Activity (scorer pages). Views run as the caller, so RLS limits them to scorers.
-- ---------------------------------------------------------------------------
-- Every claim event (rider submissions and scorer decisions), with rider and bonus
create or replace view claim_activity with (security_invoker = true) as
  select e.id, e.at, e.action, e.actor, e.from_status, e.to_status, e.reason, e.claim_id,
         r.rider_number, r.name as rider_name, c.bonus_code, b.name as bonus_name, b.points
  from claim_events e
  join claims c on c.id = e.claim_id
  join riders r on r.id = c.rider_id
  join bonuses b on b.code = c.bonus_code;

-- One row per rider: when they last opened their page, claim counts, score
create or replace view rider_activity with (security_invoker = true) as
  select r.rider_number, r.name, r.last_seen_at,
         count(c.id)                                      as claims,
         count(c.id) filter (where c.status = 'pending')  as pending,
         count(c.id) filter (where c.status = 'approved') as approved,
         count(c.id) filter (where c.status = 'denied')   as denied,
         max(c.submitted_at)                              as last_claim_at,
         coalesce((select s.score from rider_scores s where s.rider_id = r.id), 0) as score
  from riders r
  left join claims c on c.rider_id = r.id
  group by r.id, r.rider_number, r.name, r.last_seen_at;

-- ---------------------------------------------------------------------------
-- Rider functions (anon key + token)
-- ---------------------------------------------------------------------------
create or replace function rider_session(p_token uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare r riders; s settings; sc rider_scores;
begin
  r := rider_from_token(p_token);
  -- Record the visit for the activity page (at most once a minute per rider, to keep writes low)
  update riders set last_seen_at = now()
   where id = r.id and (last_seen_at is null or last_seen_at < now() - interval '1 minute');
  select * into s from settings where id = 1;
  select * into sc from rider_scores where rider_id = r.id;
  return json_build_object(
    'event_name',   s.event_name,
    'claims_open',  s.claims_open,
    'max_attempts', s.max_attempts,
    'rider',        json_build_object('number', r.rider_number, 'name', r.name),
    -- Official score, same numbers as the leader board (approved only, penalties applied)
    'score',        json_build_object('total', coalesce(sc.score, 0), 'base_points', coalesce(sc.base_points, 0),
                                      'worst_penalty', sc.worst_penalty, 'bonuses_counted', coalesce(sc.bonuses_counted, 0)),
    'bonuses', coalesce((
      select json_agg(json_build_object(
               'code', b.code, 'name', b.name, 'points', b.points,
               'description', b.description, 'is_combo', is_combo(b.code),
               'ref_photo', b.ref_photo_path,
               -- true when this bonus counts toward the score (approved, or a combo with every part approved)
               'counted', exists (select 1 from approved_effective e where e.rider_id = r.id and e.bonus_code = b.code),
               'attempts', (select count(*) from claims c where c.rider_id = r.id and c.bonus_code = b.code),
               'status', (select case
                                   when bool_or(c.status = 'approved') then 'approved'
                                   when bool_or(c.status = 'pending')  then 'pending'
                                   when count(*) > 0                   then 'denied'
                                 end
                          from claims c where c.rider_id = r.id and c.bonus_code = b.code),
               -- This rider's submissions for the bonus, newest first. The page shows them with the
               -- photo (signed by the rider-photo Edge Function) and the scorer's reason if denied.
               'history', coalesce((
                 select json_agg(json_build_object(
                          'status', c.status, 'submitted_at', c.submitted_at, 'photo_path', c.photo_path,
                          'reason', c.reason, 'by_staff', c.submitted_by not like 'rider %')
                        order by c.submitted_at desc)
                 from claims c where c.rider_id = r.id and c.bonus_code = b.code), '[]'::json))
             order by b.sort_order nulls last, b.code)
      from bonuses b where b.points >= 0), '[]'::json)
  );
end $$;

-- Photo paths belonging to a rider's claims. Only the rider-photo Edge Function calls this (as
-- service_role) to decide which photos it may sign for a rider link. Riders get no storage read
-- rule on purpose: without a login, such a rule could not tell riders apart, and listing the
-- bucket would reveal every rider's folder name, which is their secret token.
create or replace function rider_photo_paths(p_token uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare r riders;
begin
  r := rider_from_token(p_token);
  return coalesce((select array_agg(photo_path order by submitted_at)
                   from claims where rider_id = r.id and photo_path is not null), '{}');
end $$;

create or replace function rider_submit(
  p_token uuid, p_client_id uuid, p_bonus_code text,
  p_photo_path text default null, p_note text default null, p_taken_at timestamptz default null
) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  r riders; s settings; b bonuses; existing claims; n int; new_id uuid;
  v_code text := upper(trim(coalesce(p_bonus_code, '')));
begin
  r := rider_from_token(p_token);
  select * into s from settings where id = 1;

  -- Retry of a submission that already went through: return the original
  if p_client_id is not null then
    select * into existing from claims where client_id = p_client_id;
    if found then
      if existing.rider_id <> r.id then
        raise exception 'Duplicate submission id.' using errcode = 'P0001';
      end if;
      return json_build_object('claim_id', existing.id, 'status', existing.status, 'duplicate', true);
    end if;
  end if;

  if not s.claims_open then
    raise exception 'Claims are closed.' using errcode = 'P0001';
  end if;

  select * into b from bonuses where bonuses.code = v_code;
  if not found or b.points < 0 then
    raise exception 'Unknown bonus code %.', v_code using errcode = 'P0001';
  end if;

  if p_photo_path is null and not is_combo(v_code) then
    raise exception 'A photo is required for bonus %.', v_code using errcode = 'P0001';
  end if;
  -- Exactly <token>/<file name>.<ext>: no other rider's folder, no sub folders, no "../" tricks
  if p_photo_path is not null
     and p_photo_path !~ ('^' || p_token::text || '/[0-9A-Za-z_-]+\.[A-Za-z0-9]{1,5}$') then
    raise exception 'Photo does not belong to this rider.' using errcode = 'P0001';
  end if;

  if exists (select 1 from claims where rider_id = r.id and bonus_code = v_code and status = 'approved') then
    raise exception 'Bonus % is already approved for you.', v_code using errcode = 'P0001';
  end if;

  select count(*) into n from claims where rider_id = r.id and bonus_code = v_code;
  if n >= s.max_attempts then
    raise exception 'You have used all % attempts for bonus %. See rally staff.', s.max_attempts, v_code
      using errcode = 'P0001';
  end if;

  insert into claims (client_id, rider_id, bonus_code, photo_path, note, taken_at, submitted_by)
  values (p_client_id, r.id, v_code, p_photo_path, nullif(trim(p_note), ''), p_taken_at,
          'rider ' || r.rider_number)
  returning id into new_id;

  return json_build_object('claim_id', new_id, 'status', 'pending', 'duplicate', false);
end $$;

-- ---------------------------------------------------------------------------
-- Public leader board (anon key, no token needed)
-- ---------------------------------------------------------------------------
create or replace function leaderboard() returns table (
  finish bigint, rider_number int, name text, score numeric, bonuses_counted bigint
)
language sql stable security definer set search_path = public as $$
  select rank() over (order by score desc), rider_number, name, score, bonuses_counted
  from rider_scores
  order by 1, rider_number
$$;

-- ---------------------------------------------------------------------------
-- Scorer functions (logged-in scorer only)
-- ---------------------------------------------------------------------------
create or replace function require_scorer() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_scorer() then
    raise exception 'Not authorized. Your email is not on the scorer list.' using errcode = '42501';
  end if;
end $$;

create or replace function require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Not authorized. Only rally admins can do this.' using errcode = '42501';
  end if;
end $$;

create or replace function scorer_decide(p_claim_id uuid, p_status claim_status, p_reason text default null)
returns claims
language plpgsql volatile security definer set search_path = public as $$
declare c claims;
begin
  perform require_scorer();
  update claims set status = p_status, reason = nullif(trim(p_reason), '')
  where id = p_claim_id returning * into c;
  if not found then raise exception 'Claim not found.' using errcode = 'P0001'; end if;
  return c;
exception when unique_violation then
  raise exception 'This rider already has another approved claim for this bonus.' using errcode = 'P0001';
end $$;

create or replace function scorer_add_claim(
  p_rider_number int, p_bonus_code text, p_status claim_status default 'pending',
  p_note text default null, p_photo_path text default null, p_reason text default null
) returns claims
language plpgsql volatile security definer set search_path = public as $$
declare r riders; c claims; v_code text := upper(trim(coalesce(p_bonus_code, '')));
begin
  perform require_scorer();
  select * into r from riders where rider_number = p_rider_number;
  if not found then raise exception 'Rider % not found.', p_rider_number using errcode = 'P0001'; end if;
  if not exists (select 1 from bonuses where bonuses.code = v_code) then
    raise exception 'Bonus % not found.', v_code using errcode = 'P0001';
  end if;
  insert into claims (rider_id, bonus_code, status, note, photo_path, reason, submitted_by)
  values (r.id, v_code, p_status, nullif(trim(p_note), ''), p_photo_path, nullif(trim(p_reason), ''),
          current_email())
  returning * into c;
  return c;
exception when unique_violation then
  raise exception 'Rider % already has bonus % approved.', p_rider_number, v_code using errcode = 'P0001';
end $$;

create or replace function scorer_new_token(p_rider_number int) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare t uuid;
begin
  perform require_admin();
  update riders set token = gen_random_uuid() where rider_number = p_rider_number returning token into t;
  if t is null then raise exception 'Rider % not found.', p_rider_number using errcode = 'P0001'; end if;
  return t;
end $$;

-- Scorer list with role and last sign-in time from Supabase Auth (for the activity page).
-- Dropped first because its columns changed (is_admin added); create or replace cannot do that.
drop function if exists scorer_list();
create function scorer_list() returns table (email text, is_admin boolean, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_scorer();
  return query
    select s.email, s.is_admin, (select max(u.last_sign_in_at) from auth.users u where lower(u.email) = s.email)
    from scorers s order by s.email;
end $$;

create or replace function scorer_delete_all_claims(p_confirm text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  perform require_admin();
  if p_confirm <> 'DELETE ALL CLAIMS' then
    raise exception 'Type DELETE ALL CLAIMS to confirm.' using errcode = 'P0001';
  end if;
  delete from claims where true;
  get diagnostics n = row_count;
  return n;
end $$;

-- Delete every rider, bonus or combo (admin page). p_what is 'riders', 'bonuses' or 'combos';
-- p_confirm must be the matching phrase, e.g. 'DELETE ALL RIDERS'. Riders and bonuses take their
-- claims with them (a claim cannot exist without both). Deleting combos keeps the combo bonuses
-- themselves and only removes which bonuses make up each combo. Photos stay in storage.
create or replace function admin_delete_all(p_what text, p_confirm text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int; phrase text := 'DELETE ALL ' || upper(coalesce(p_what, ''));
begin
  perform require_admin();
  if p_what not in ('riders', 'bonuses', 'combos') then
    raise exception 'Unknown list %.', p_what using errcode = 'P0001';
  end if;
  if coalesce(p_confirm, '') <> phrase then
    raise exception 'Type % to confirm.', phrase using errcode = 'P0001';
  end if;
  if p_what = 'riders' then
    delete from riders where true;            -- claims go with them (on delete cascade)
  elsif p_what = 'bonuses' then
    delete from claims where true;            -- every claim is for some bonus
    delete from bonuses where true;           -- combo members go with them
  else
    delete from combo_members where true;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- Set which bonuses make up a combo, all at once (admin page). An empty list removes the combo
-- (the combo bonus itself stays). Returns the number of members saved.
create or replace function admin_set_combo(p_combo text, p_members text[]) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_combo text := upper(trim(coalesce(p_combo, ''))); v_members text[]; bad text;
begin
  perform require_admin();
  select coalesce(array_agg(distinct m), '{}') into v_members
    from (select upper(trim(x)) m from unnest(coalesce(p_members, '{}')) x) t where m <> '';
  if not exists (select 1 from bonuses where code = v_combo) then
    raise exception 'Bonus % not found. Add the combo as a bonus first.', v_combo using errcode = 'P0001';
  end if;
  if v_combo = any (v_members) then
    raise exception 'A combo cannot include itself.' using errcode = 'P0001';
  end if;
  select string_agg(m, ', ' order by m) into bad
    from unnest(v_members) m where not exists (select 1 from bonuses where code = m);
  if bad is not null then
    raise exception 'Bonus not found: %.', bad using errcode = 'P0001';
  end if;
  if cardinality(v_members) = 1 then
    raise exception 'A combo needs at least 2 bonuses.' using errcode = 'P0001';
  end if;
  delete from combo_members where combo_code = v_combo;
  insert into combo_members (combo_code, member_code) select v_combo, m from unnest(v_members) m;
  return cardinality(v_members);
end $$;

-- ---------------------------------------------------------------------------
-- Row level security: scorers read everything, admins change the event setup, anon sees nothing
-- ---------------------------------------------------------------------------
alter table settings      enable row level security;
alter table scorers       enable row level security;
alter table riders        enable row level security;
alter table bonuses       enable row level security;
alter table combo_members enable row level security;
alter table claims        enable row level security;
alter table claim_events  enable row level security;

-- Event setup: every scorer reads it (the review page needs riders and bonuses), only admins change it
drop policy if exists scorer_all on settings;
drop policy if exists scorer_all on riders;
drop policy if exists scorer_all on bonuses;
drop policy if exists scorer_all on combo_members;
drop policy if exists scorer_read on settings;
create policy scorer_read on settings      for select to authenticated using (is_scorer());
drop policy if exists admin_all on settings;
create policy admin_all on settings        for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists scorer_read on riders;
create policy scorer_read on riders        for select to authenticated using (is_scorer());
drop policy if exists admin_all on riders;
create policy admin_all on riders          for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists scorer_read on bonuses;
create policy scorer_read on bonuses       for select to authenticated using (is_scorer());
drop policy if exists admin_all on bonuses;
create policy admin_all on bonuses         for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists scorer_read on combo_members;
create policy scorer_read on combo_members for select to authenticated using (is_scorer());
drop policy if exists admin_all on combo_members;
create policy admin_all on combo_members   for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists scorer_read on scorers;
create policy scorer_read on scorers      for select to authenticated using (is_scorer());
drop policy if exists scorer_read on claims;
create policy scorer_read on claims       for select to authenticated using (is_scorer());
drop policy if exists scorer_read on claim_events;
create policy scorer_read on claim_events for select to authenticated using (is_scorer());
-- Claims change only through scorer_decide / scorer_add_claim / rider_submit (status rules + audit)

-- Table and view access
-- Explicit, so the schema works whether or not the project auto-exposes new tables to the Data API.
-- Grants say which commands a role may try; the RLS policies above still decide which rows.
-- anon gets no table access at all: riders and the leader board go through security definer functions.
grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select, insert, update, delete on settings, riders, bonuses, combo_members to authenticated;
grant select on scorers, claims, claim_events to authenticated;
grant select on approved_direct, approved_effective, rider_scores, claims_detail,
                claim_activity, rider_activity to authenticated;
grant usage, select on sequence riders_id_seq to authenticated;   -- admin page adds riders
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Function access
-- Supabase grants anon/authenticated execute by default, so revoke from them explicitly
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function rider_session(uuid)                                       to anon, authenticated;
grant execute on function rider_submit(uuid, uuid, text, text, text, timestamptz)   to anon, authenticated;
grant execute on function leaderboard()                                             to anon, authenticated;
grant execute on function is_scorer()                                               to anon, authenticated;
grant execute on function is_admin()                                                to anon, authenticated;
grant execute on function staff_role()                                              to anon, authenticated;
grant execute on function current_email()                                           to anon, authenticated;
grant execute on function rider_token_valid(text)                                   to anon, authenticated;
grant execute on function is_combo(text)                                            to anon, authenticated;
grant execute on function scorer_decide(uuid, claim_status, text)                   to authenticated;
grant execute on function scorer_add_claim(int, text, claim_status, text, text, text) to authenticated;
grant execute on function scorer_new_token(int)                                     to authenticated;
grant execute on function scorer_delete_all_claims(text)                            to authenticated;
grant execute on function scorer_list()                                             to authenticated;
grant execute on function rider_photo_paths(uuid)                                   to service_role;  -- Edge Function only
grant execute on function require_scorer()                                          to authenticated;
grant execute on function require_admin()                                           to authenticated;
grant execute on function admin_delete_all(text, text)                              to authenticated;
grant execute on function admin_set_combo(text, text[])                             to authenticated;

-- ---------------------------------------------------------------------------
-- Photo storage: private bucket "claims"
--   riders upload to  <their token>/<file>   (anon, insert only)
--   scorers upload to scorer/<file> and can read everything
--   riders view their own photos through the rider-photo Edge Function (no rider read rule here)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claims', 'claims', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

-- Rider uploads must be exactly <token>/<file name>.<ext> (no sub folders, no "..")
drop policy if exists rider_upload on storage.objects;
create policy rider_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'claims'
              and name ~ '^[0-9a-fA-F-]{36}/[0-9A-Za-z_-]+\.[A-Za-z0-9]{1,5}$'
              and public.rider_token_valid(split_part(name, '/', 1)));

drop policy if exists scorer_upload on storage.objects;
create policy scorer_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'claims' and public.is_scorer());

drop policy if exists scorer_read_photos on storage.objects;
create policy scorer_read_photos on storage.objects for select to authenticated
  using (bucket_id = 'claims' and public.is_scorer());

-- ---------------------------------------------------------------------------
-- Reference photos: public bucket "bonus-photos"
--   Shows riders and scorers what each bonus should look like. Public so the rider page (no login)
--   and anything else (a printed rally book, say) can show a photo by its link. Files get random
--   names and nobody but admins may list the bucket, so a photo is only seen by someone given its link.
--   Only admins upload, replace or delete.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bonus-photos', 'bonus-photos', true, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

drop policy if exists admin_ref_insert on storage.objects;
create policy admin_ref_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bonus-photos' and public.is_admin());
drop policy if exists admin_ref_read on storage.objects;
create policy admin_ref_read on storage.objects for select to authenticated
  using (bucket_id = 'bonus-photos' and public.is_admin());
drop policy if exists admin_ref_delete on storage.objects;
create policy admin_ref_delete on storage.objects for delete to authenticated
  using (bucket_id = 'bonus-photos' and public.is_admin());
