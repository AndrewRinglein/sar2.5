-- ============================================================================
-- SAR 2.0 — U3, part 1: access tokens for the Operational DB
-- Project: lkcfbgnuodqzvowschjn  ("Operational DB")
-- Applied: 2026-08-12 as migration `sar2_ops_access_tokens`
--
-- Deliberately a SEPARATE token table from the SAR project's. The two
-- databases fail independently (IMPL §3.2a), and a token that opens one
-- should not be assumed to open the other. Revoking Ops access must not
-- require revoking SAR access.
--
-- Same shape as the SAR project's 001: RLS on, zero policies, hashes only,
-- admin functions revoked from anon and authenticated.
-- ============================================================================

create table if not exists public.sar2_tokens (
  id           uuid        primary key default gen_random_uuid(),
  token_hash   text        not null unique,
  label        text        not null,
  customer_id  text        not null default 'vanguard',
  created_at   timestamptz not null default now(),
  created_by   text,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  use_count    bigint      not null default 0
);

comment on table public.sar2_tokens is
  'SAR 2.0 link tokens for the Ops database. RLS on, no policies — reachable '
  'only via ops_read(). Hashes only; plaintext is shown once at mint time.';

alter table public.sar2_tokens enable row level security;
-- DELIBERATELY NO POLICIES.

revoke all on public.sar2_tokens from anon, authenticated;

create index if not exists sar2_tokens_live_idx
  on public.sar2_tokens (token_hash) where revoked_at is null;

create or replace function public.sar2_mint_token(
  p_label       text,
  p_customer_id text default 'vanguard',
  p_expires_at  timestamptz default null
)
returns table (token text, id uuid)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_token text; v_id uuid;
begin
  if coalesce(trim(p_label), '') = '' then
    raise exception 'sar2_mint_token: a label is required';
  end if;
  v_token := rtrim(replace(replace(encode(gen_random_bytes(32),'base64'),'+','-'),'/','_'), '=');
  insert into public.sar2_tokens (token_hash, label, customer_id, expires_at, created_by)
  values (encode(extensions.digest(v_token,'sha256'),'hex'), trim(p_label), p_customer_id, p_expires_at, current_user)
  returning sar2_tokens.id into v_id;
  return query select v_token, v_id;
end $$;

revoke all on function public.sar2_mint_token(text, text, timestamptz) from public, anon, authenticated;

create or replace function public.sar2_revoke_token(p_id uuid)
returns boolean language sql security definer
set search_path = public, pg_temp
as $$
  update public.sar2_tokens set revoked_at = now()
   where id = p_id and revoked_at is null returning true;
$$;

revoke all on function public.sar2_revoke_token(uuid) from public, anon, authenticated;

create or replace function public.sar2_check_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_id uuid;
begin
  if p_token is null or length(p_token) < 20 then
    raise exception 'unauthorised' using errcode = '28000';
  end if;
  select t.id into v_id from public.sar2_tokens t
   where t.token_hash = encode(extensions.digest(p_token,'sha256'),'hex')
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now());
  if v_id is null then
    -- One message for absent, revoked and expired alike.
    raise exception 'unauthorised' using errcode = '28000';
  end if;
  update public.sar2_tokens set last_used_at = now(), use_count = use_count + 1 where id = v_id;
  return v_id;
end $$;

revoke all on function public.sar2_check_token(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- drop function if exists public.sar2_check_token(text);
-- drop function if exists public.sar2_revoke_token(uuid);
-- drop function if exists public.sar2_mint_token(text, text, timestamptz);
-- drop table if exists public.sar2_tokens;
