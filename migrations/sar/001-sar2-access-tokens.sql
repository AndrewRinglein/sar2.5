-- ============================================================================
-- SAR 2.0 — U2, part 1: the access token table
-- Project: bstcgfjvtdajgcdpjisg  ("Vanguard SAR + Com + Finances")
-- Applied: 2026-08-12 as migration `sar2_access_tokens`
--
-- Follows the platform's existing `short_links` pattern: RLS enabled with
-- ZERO policies, so no role can read this table through PostgREST at all.
-- The only door is a SECURITY DEFINER function (002), which runs as the
-- table owner and therefore bypasses RLS.
--
-- Tokens are stored as SHA-256 hashes, never in plaintext. A leaked database
-- dump does not yield working tokens. The plaintext is returned exactly once,
-- at mint time, and is not recoverable afterwards.
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
  'SAR 2.0 link tokens. RLS on, no policies — reachable only via sar_read(). '
  'Hashes only; plaintext is shown once at mint time.';

alter table public.sar2_tokens enable row level security;

-- DELIBERATELY NO POLICIES. Adding one re-opens the table to PostgREST.
-- Note this table is the ONLY one in the schema without an "Allow all"
-- policy; see SPEC §19.24.

revoke all on public.sar2_tokens from anon, authenticated;

create index if not exists sar2_tokens_live_idx
  on public.sar2_tokens (token_hash)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Minting. Admin-only: EXECUTE is revoked from anon and authenticated, so this
-- is reachable through the management connection but not through the API.
-- ---------------------------------------------------------------------------
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
declare
  v_token text;
  v_id    uuid;
begin
  if coalesce(trim(p_label), '') = '' then
    raise exception 'sar2_mint_token: a label is required';
  end if;

  -- 32 bytes of CSPRNG, url-safe. Long enough that guessing is not a threat
  -- model, short enough to sit in a text message.
  v_token := replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_');
  v_token := rtrim(v_token, '=');

  insert into public.sar2_tokens (token_hash, label, customer_id, expires_at, created_by)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'),
          trim(p_label), p_customer_id, p_expires_at, current_user)
  returning sar2_tokens.id into v_id;

  return query select v_token, v_id;
end;
$$;

revoke all on function public.sar2_mint_token(text, text, timestamptz) from public, anon, authenticated;

create or replace function public.sar2_revoke_token(p_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.sar2_tokens set revoked_at = now()
   where id = p_id and revoked_at is null
  returning true;
$$;

revoke all on function public.sar2_revoke_token(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- drop function if exists public.sar2_revoke_token(uuid);
-- drop function if exists public.sar2_mint_token(text, text, timestamptz);
-- drop table if exists public.sar2_tokens;
