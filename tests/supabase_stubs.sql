-- Minimal stand-ins for the parts of Supabase that schema.sql relies on,
-- so the real schema can run inside PGlite for tests.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;

create schema storage;
create table storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to anon, authenticated;
grant select, insert on storage.objects to anon, authenticated;
grant execute on function storage.foldername(text) to anon, authenticated;

-- Supabase default privileges. Tables get NO default grants here, as in a project created with
-- "automatically expose new tables" turned off; schema.sql must grant table access itself.
-- (Projects with it on also grant all on tables; schema.sql revokes that, so both cases end the same.)
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
