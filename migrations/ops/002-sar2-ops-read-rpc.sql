-- ============================================================================
-- SAR 2.0 — U3, part 2: ops_read(token, sections, since)
-- Project: lkcfbgnuodqzvowschjn  ("Operational DB")
-- Applied: 2026-08-12 as `sar2_ops_read_rpc`, then `sar2_ops_read_rpc_sizing`
--
-- Read-only, token-gated, SECURITY DEFINER with a pinned search_path.
--
-- REDACTION IS SERVER-SIDE (IMPL §4). These are never returned, and the client
-- is not trusted to decline to display them:
--
--   sched_staff.phone, sched_staff.email   personal contact details
--   vendors.email, vendors.contact_name    supplier contact details
--   settings                               holds secrets in plaintext
--   events                                 audit log
--
-- Commission, shares, hours, overtime and break-premium HOURS are returned.
-- They are public within the business (SPEC §22.1.8). There is no wage, base
-- rate or regular rate anywhere in this database, so none can leak.
--
-- SECTIONS. Measured on real data:
--     inventory   2,344 kB
--     usage       2,302 kB   (913 kB with a 90-day window)
--     schedule      351 kB
--     commission     12 kB
--     all four    5,009 kB
--
-- Five megabytes is too much for one browser call. Screens request the
-- sections they need; nothing in the product should ever ask for all four.
-- The default is all four only so an exploratory call is not silently
-- truncated — a partial answer that looks complete is worse than a big one.
--
-- p_since covers sessions, plays, assignments, time entries AND boxes. Boxes
-- in a live state (in_inventory, opened) are always returned regardless of
-- age: current stock is not a time-scoped question, and dropping an old
-- unopened box would understate inventory on hand.
--
-- NOTE: as of 2026-08-12 every box is dated 2026-07-01 or later, so the boxes
-- window is currently a no-op. The inventory system is roughly six weeks old.
-- Run rates and days-of-cover have very little history to stand on.
-- ============================================================================

create or replace function public.ops_read(
  p_token    text,
  p_sections text[] default array['inventory','usage','schedule','commission'],
  p_since    date   default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token_id uuid;
  v_out      jsonb;
  v_want     text[] := coalesce(p_sections, array['inventory','usage','schedule','commission']);
begin
  v_token_id := public.sar2_check_token(p_token);

  v_out := jsonb_build_object(
    'meta', jsonb_build_object(
      'source',       'ops',
      'project',      'lkcfbgnuodqzvowschjn',
      'generated_at', now(),
      'sections',     to_jsonb(v_want),
      'since',        p_since,
      'money_unit',   'dollars',
      'redacted',     jsonb_build_array(
        'sched_staff.phone', 'sched_staff.email',
        'vendors.email', 'vendors.contact_name',
        'settings', 'events')
    ),
    'halls', (select coalesce(jsonb_agg(to_jsonb(h) order by h.name), '[]'::jsonb) from public.halls h)
  );

  if 'inventory' = any(v_want) then
    v_out := v_out || jsonb_build_object(
      'products',  (select coalesce(jsonb_agg(to_jsonb(p) order by p.name), '[]'::jsonb) from public.products p),
      'boxes', (
        select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb)
          from public.boxes b
         where p_since is null
            or b.state in ('in_inventory','opened')      -- live stock, always
            or coalesce(b.received_at, b.ordered_at)::date >= p_since
            or coalesce(b.opened_at, b.sold_out_at)::date  >= p_since),
      'purchase_orders', (select coalesce(jsonb_agg(to_jsonb(po) order by po.created_at), '[]'::jsonb) from public.purchase_orders po),
      'po_lines',  (select coalesce(jsonb_agg(to_jsonb(pl)), '[]'::jsonb) from public.po_lines pl),
      'deliveries',(select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) from public.deliveries d),
      'shipments', (select coalesce(jsonb_agg(to_jsonb(sh)), '[]'::jsonb) from public.shipments sh),
      'vendors', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', v.id, 'name', v.name, 'tax_rate', v.tax_rate, 'active', v.active,
                 'packing_fee', v.packing_fee, 'packing_types', v.packing_types) order by v.name), '[]'::jsonb)
          from public.vendors v)
    );
  end if;

  if 'usage' = any(v_want) then
    v_out := v_out || jsonb_build_object(
      'sessions', (
        select coalesce(jsonb_agg(to_jsonb(s) order by s.session_date, s.part), '[]'::jsonb)
          from public.sessions s
         where p_since is null or s.session_date >= p_since),
      'session_plays', (
        select coalesce(jsonb_agg(to_jsonb(sp)), '[]'::jsonb)
          from public.session_plays sp
          join public.sessions s on s.id = sp.session_id
         where p_since is null or s.session_date >= p_since)
    );
  end if;

  if 'schedule' = any(v_want) then
    v_out := v_out || jsonb_build_object(
      'sched_staff', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', st.id, 'name', st.name,
                 'first_name', st.first_name, 'last_name', st.last_name,
                 'active', st.active, 'on_roster', st.on_roster,
                 'employee_ref', st.employee_ref,
                 'pet', st.pet, 'pet_kind', st.pet_kind,
                 'deactivated_at', st.deactivated_at) order by st.name), '[]'::jsonb)
          from public.sched_staff st),
      'sched_roles',      (select coalesce(jsonb_agg(to_jsonb(r) order by r.sort), '[]'::jsonb) from public.sched_roles r),
      'sched_periods',    (select coalesce(jsonb_agg(to_jsonb(pe) order by pe.starts_on), '[]'::jsonb) from public.sched_periods pe),
      'sched_sessions',   (select coalesce(jsonb_agg(to_jsonb(ss) order by ss.session_date, ss.part), '[]'::jsonb)
                             from public.sched_sessions ss
                            where p_since is null or ss.session_date >= p_since),
      'sched_assignments',(select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
                             from public.sched_assignments a
                             join public.sched_sessions ss on ss.id = a.session_id
                            where p_since is null or ss.session_date >= p_since),
      'sched_time_entries',(select coalesce(jsonb_agg(to_jsonb(te)), '[]'::jsonb)
                             from public.sched_time_entries te
                            where p_since is null or te.work_date >= p_since)
    );
  end if;

  if 'commission' = any(v_want) then
    v_out := v_out || jsonb_build_object(
      'sched_commission_payouts', (
        select coalesce(jsonb_agg(to_jsonb(cp) order by cp.session_date), '[]'::jsonb)
          from public.sched_commission_payouts cp
         where p_since is null or cp.session_date >= p_since),
      'sched_session_shares', (
        select coalesce(jsonb_agg(to_jsonb(sh)), '[]'::jsonb) from public.sched_session_shares sh),
      -- The live commission target. SPEC §3.2: sessions.target_rpa is null on
      -- every row in the SAR database, so this is where the target comes from.
      -- Keyed (hall_id, dow, part) — e.g. rwc / Tuesday / PM => 459.38.
      'sched_rpa_defaults', (
        select coalesce(jsonb_agg(to_jsonb(rd)), '[]'::jsonb) from public.sched_rpa_defaults rd)
    );
  end if;

  -- Size last, so the client can see what it pulled rather than guess.
  return jsonb_set(v_out, '{meta,bytes}', to_jsonb(length(v_out::text)));
end;
$$;

comment on function public.ops_read(text, text[], date) is
  'SAR 2.0 Ops read endpoint. Token-gated, read-only, PII redacted server-side.';

revoke all on function public.ops_read(text, text[], date) from public;
grant execute on function public.ops_read(text, text[], date) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Usage
-- ---------------------------------------------------------------------------
--   select token, id from public.sar2_mint_token('Andrew — laptop');
--
--   POST /rest/v1/rpc/ops_read
--     { "p_token": "<token>", "p_sections": ["commission"] }
--     { "p_token": "<token>", "p_sections": ["usage"], "p_since": "2026-05-01" }
--
-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- drop function if exists public.ops_read(text, text[], date);
