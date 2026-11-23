-- Minimal local Supabase auth/storage contracts for SQL boundary tests.
-- Not a substitute for GoTrue, actual object storage or phone acceptance.
create schema if not exists auth; create schema if not exists storage; create schema if not exists extensions;
do $$ begin create role anon; exception when others then null; end $$;
do $$ begin create role authenticated; exception when others then null; end $$;
do $$ begin create role service_role bypassrls; exception when others then null; end $$;
create table auth.users(id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, created_at timestamptz default now(), phone text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select current_user::text $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create table storage.buckets(id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), path_tokens text[]);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
create function storage.filename(name text) returns text language sql immutable as $$ select (string_to_array(name,'/'))[array_length(string_to_array(name,'/'),1)] $$;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant select on storage.objects to authenticated, service_role;

-- TEST ONLY: Vault API contract shim. It stores plaintext fixture values and
-- tests transactional permissions/lifecycle only, NOT Vault encryption/crypto.
-- Hosted environments must already provide the real Supabase Vault extension.
create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid(), secret text not null, name text unique, description text);
create view vault.decrypted_secrets as select id,secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text,new_name text default null,new_description text default '',new_key_id uuid default null)
returns uuid language sql as $$ insert into vault.secrets(secret,name,description) values(new_secret,new_name,new_description) returning id $$;
create function vault.update_secret(secret_id uuid,new_secret text default null,new_name text default null,new_description text default null,new_key_id uuid default null)
returns void language sql as $$ update vault.secrets set secret=coalesce(new_secret,secret),name=coalesce(new_name,name),description=coalesce(new_description,description) where id=secret_id $$;
revoke all on schema vault from public,anon,authenticated,service_role;
revoke all on all tables in schema vault from public,anon,authenticated,service_role;
revoke all on all functions in schema vault from public,anon,authenticated,service_role;
