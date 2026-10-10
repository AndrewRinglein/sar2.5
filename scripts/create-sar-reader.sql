-- SAR 2.0 — a read-only login for the Operations database.
--
-- Run once in Supabase → Operational DB → SQL Editor. It creates a NEW login
-- (sar_reader) with its own password. It does not touch the main postgres
-- password, any table, or any other app.
--
-- BEFORE RUNNING: replace CHANGE-ME on the line below with a new password
-- of your own — letters and numbers only, 20+ characters. Keep it; it goes
-- into .env.local. Nobody else needs it.
--
-- What sar_reader can do: read only the columns listed below. Every
-- transaction is read-only. It cannot see pay rates or break-premium money,
-- and cannot write, delete or change anything.
-- bypassrls: these tables have row-level security with no policy for this
-- login; without it every read would return zero rows. The column grants
-- below are what limit it.
--
-- To remove it later:  drop owned by sar_reader; drop role sar_reader;

create role sar_reader login password 'CHANGE-ME' bypassrls;
alter role sar_reader set default_transaction_read_only = on;
alter role sar_reader set statement_timeout = '30s';
grant usage on schema public to sar_reader;

grant select (id, name, color, sort, active) on public.sched_roles to sar_reader;
grant select (id, name, first_name, active, on_roster) on public.sched_staff to sar_reader;
grant select (id, hall_id, session_date, part, day_type, status, total_sales, attendance, comm_rate, target_rpa, actual_rpa) on public.sched_sessions to sar_reader;
grant select (id, session_id, role_id, staff_id, slot_index, is_training, scheduled_start, scheduled_end) on public.sched_assignments to sar_reader;
grant select (id, session_id, staff_id, session_date, shares, total_shares, commission_pool, payout_amount, confirmed_at) on public.sched_commission_payouts to sar_reader;
grant select (session_id, staff_id, shares) on public.sched_session_shares to sar_reader;
grant select (id, staff_id, hall_id, work_date, hours_worked, category, is_walk_up, clock_in, clock_out, meal_taken, meal_start, meal_waived, second_meal_taken, second_meal_waived, rest_breaks_taken, is_worked_time, assignment_id) on public.sched_time_entries to sar_reader;
grant select (staff_id, role_id, can_do, is_deputy) on public.sched_staff_role_capability to sar_reader;
grant select (staff_id, dow, part, available) on public.sched_staff_availability to sar_reader;
grant select (hall_id, role_id, dow, part, start_time, end_time, is_placeholder) on public.sched_hall_role_times to sar_reader;
grant select (hall_id, role_id, dow, part, needed, min_on_floor) on public.sched_hall_role_needs to sar_reader;
grant select (session_id, role_id, needed) on public.sched_session_roles to sar_reader;
grant select (hall_id, dow, part, target_rpa) on public.sched_rpa_defaults to sar_reader;
grant select (id, vendor_id, name, type, cost, tickets, price_per_ticket, active, stock_unit) on public.products to sar_reader;
grant select (id, hall_id, product_id, serial, cost, state, session_tag, received_at, opened_at, sold_out_at, tickets_remaining, session_id) on public.boxes to sar_reader;
grant select (hall_id, session_date, part, category, name_raw, product_id, game, game_type, vendor_id, distributor, still_stocked, qty) on public.game_usage to sar_reader;
grant select (id, num, hall_id, vendor_id, status, subtotal, tax, total, sent_at, archived_at) on public.purchase_orders to sar_reader;
grant select (id, name, active) on public.vendors to sar_reader;
grant select (id, hall_id, session_date, session_time, slot_name, status, closed_at, updated_at, state, hotball_ledger) on public.recon_sessions to sar_reader;
-- Hotball pots: cash movements recorded in Session Reconciliation, without who recorded them.
grant select (id, pot_key, movement_date, session_time, kind, amount, note, created_at, voided_at) on public.hotball_cash_movements to sar_reader;
-- Base tables behind the game_usage view (it runs with the reader's rights).
grant select (session_id, product_id, category, name_raw, qty, serial) on public.session_plays to sar_reader;
grant select (id, hall_id, session_date, part, weekday, historical) on public.sessions to sar_reader;
