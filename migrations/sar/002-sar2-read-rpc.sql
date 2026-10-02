-- ============================================================================
-- SAR 2.0 — U2, part 2: sar_read(token)
-- Project: bstcgfjvtdajgcdpjisg  ("Vanguard SAR + Com + Finances")
-- Applied: 2026-08-12 as migration `sar2_read_rpc`
--
-- The only door into this database for the dashboard. SECURITY DEFINER, so it
-- runs as the owner and can read tables whose RLS would otherwise stop it.
-- Read-only: no statement below writes anything except the token's own
-- last-used bookkeeping.
--
-- search_path is pinned. An unpinned search_path on a SECURITY DEFINER
-- function lets a caller shadow a table name and have the function read
-- theirs instead.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Token check, shared by every read entry point.
-- ---------------------------------------------------------------------------
create or replace function public.sar2_check_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_token is null or length(p_token) < 20 then
    raise exception 'unauthorised' using errcode = '28000';
  end if;

  select t.id into v_id
    from public.sar2_tokens t
   where t.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now());

  if v_id is null then
    -- One message for absent, revoked and expired alike: a caller probing the
    -- endpoint learns nothing about which tokens exist.
    raise exception 'unauthorised' using errcode = '28000';
  end if;

  update public.sar2_tokens
     set last_used_at = now(), use_count = use_count + 1
   where id = v_id;

  return v_id;
end;
$$;

revoke all on function public.sar2_check_token(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The main read. Sessions, locations, expenses, and honest metadata.
--
-- Item detail is deliberately NOT here — 48,589 rows would triple the payload
-- for screens that never open it. It has its own entry point below.
-- ---------------------------------------------------------------------------
create or replace function public.sar_read(
  p_token text,
  p_since date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token_id uuid;
  v_out      jsonb;
begin
  v_token_id := public.sar2_check_token(p_token);

  select jsonb_build_object(

    'meta', jsonb_build_object(
      'source',       'sar',
      'project',      'bstcgfjvtdajgcdpjisg',
      'generated_at', now(),
      'since',        p_since,
      'currency',     'USD',
      -- Stated explicitly so no client ever divides by 100 again.
      'money_unit',   'dollars',
      'session_key',  jsonb_build_array('location_id','session_date','session_type')
    ),

    'locations', (
      select coalesce(jsonb_agg(to_jsonb(l) order by l.name), '[]'::jsonb)
        from public.locations l
    ),

    'sessions', (
      select coalesce(jsonb_agg(to_jsonb(s) order by s.session_date, s.session_type), '[]'::jsonb)
        from public.sessions s
       where p_since is null or s.session_date >= p_since
    ),

    'monthly_expenses', (
      select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
        from public.monthly_expenses m
    ),

    -- Coverage, computed server-side. SPEC §3.6: every screen must be able to
    -- say "not recorded" instead of drawing a zero. This is the data that lets
    -- it. Item coverage is per location-month so a client can grey out exactly
    -- the months that have no detail.
    'coverage', (
      select coalesce(jsonb_agg(c order by c->>'month', c->>'location'), '[]'::jsonb)
        from (
          select jsonb_build_object(
                   'location',      l.name,
                   'month',         to_char(s.session_date, 'YYYY-MM'),
                   'sessions',      count(distinct s.id),
                   'with_items',    count(distinct ps.session_id),
                   'item_rows',     count(ps.id),
                   'with_recon',    count(distinct r.session_id)
                 ) as c
            from public.sessions s
            join public.locations l on l.id = s.location_id
            left join public.session_pos_sales ps          on ps.session_id = s.id
            left join public.session_pos_reconciliation r  on r.session_id  = s.id
           where p_since is null or s.session_date >= p_since
           group by l.name, to_char(s.session_date, 'YYYY-MM')
        ) q
    )
  ) into v_out;

  return v_out;
end;
$$;

comment on function public.sar_read(text, date) is
  'SAR 2.0 read endpoint. Token-gated, read-only. Money is dollars, not cents.';

revoke all on function public.sar_read(text, date) from public;
grant execute on function public.sar_read(text, date) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Item detail and station reconciliation, fetched per session on demand.
-- Capped so a caller cannot ask for the whole table in one request.
-- ---------------------------------------------------------------------------
create or replace function public.sar_read_items(
  p_token       text,
  p_session_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token_id uuid;
begin
  v_token_id := public.sar2_check_token(p_token);

  if p_session_ids is null or array_length(p_session_ids, 1) is null then
    return jsonb_build_object('items', '[]'::jsonb, 'reconciliation', '[]'::jsonb);
  end if;

  if array_length(p_session_ids, 1) > 200 then
    raise exception 'sar_read_items: at most 200 sessions per call, got %',
      array_length(p_session_ids, 1);
  end if;

  return jsonb_build_object(
    'items', (
      select coalesce(jsonb_agg(to_jsonb(ps) order by ps.session_id, ps.row_number), '[]'::jsonb)
        from public.session_pos_sales ps
       where ps.session_id = any(p_session_ids)
    ),
    'reconciliation', (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.session_id, r.origin), '[]'::jsonb)
        from public.session_pos_reconciliation r
       where r.session_id = any(p_session_ids)
    )
  );
end;
$$;

revoke all on function public.sar_read_items(text, uuid[]) from public;
grant execute on function public.sar_read_items(text, uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Usage
-- ---------------------------------------------------------------------------
-- Mint (management connection only):
--   select token, id from public.sar2_mint_token('Andrew — laptop');
--
-- Read (anon key + token, from the browser):
--   POST /rest/v1/rpc/sar_read   { "p_token": "<token>" }
--   POST /rest/v1/rpc/sar_read   { "p_token": "<token>", "p_since": "2026-01-01" }
--   POST /rest/v1/rpc/sar_read_items { "p_token": "<token>", "p_session_ids": [...] }
--
-- Revoke:
--   select public.sar2_revoke_token('<uuid>');

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- drop function if exists public.sar_read_items(text, uuid[]);
-- drop function if exists public.sar_read(text, date);
-- drop function if exists public.sar2_check_token(text);
