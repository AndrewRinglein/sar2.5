-- SAR 2.0 — security clean-up and the Ask SAR daily allowance.
--
-- Run in Supabase → SQL Editor, once in EACH of these two projects:
--   • Operational DB              (lkcfbgnuodqzvowschjn)
--   • Vanguard SAR + Com + Finances (bstcgfjvtdajgcdpjisg)
-- It is safe to run more than once, and safe to run in a project where some
-- of these things do not exist — each step skips what is not there.
--
-- What it does, in plain words:
--
--   1. Removes the old "link token" read functions. SAR 2.0 stopped using
--      them when it moved to signed-in access, but they are still callable
--      by anyone on the internet who holds an old link token:
--        ops_read        (Operational DB)
--        sar_read        (SAR project)
--        sar_read_items  (SAR project)
--
--   2. Switches off every old link token. Nothing is deleted: each token
--      that is still live is marked revoked as of now, so the record of who
--      had one is kept. (Deleting is not needed once the functions are gone,
--      and a revoked token cannot be revived by accident.)
--
--   3. Operational DB only: creates the table that counts Ask SAR questions
--      per person per day, so the daily limit holds across restarts. It has
--      row-level security switched on and NO policies, and anon/authenticated
--      have no rights on it: only the server (the Edge Function, which connects
--      as the project's own postgres role) can read or write it. The table
--      stores an account id, a date and two counters — never a question or
--      an answer.
--
-- It does not touch any other table, function, login or password.
--
-- To undo step 3 later:  drop table if exists public.sar2_ask_usage;
-- (Steps 1 and 2 are not meant to be undone.)

begin;

-- 1. The old token-gated read functions.
drop function if exists public.ops_read(text, text[], date);
drop function if exists public.sar_read(text, date);
drop function if exists public.sar_read_items(text, uuid[]);

-- 2. Every outstanding link token, revoked (kept for the record).
do $$
begin
  if to_regclass('public.sar2_tokens') is not null then
    update public.sar2_tokens
       set revoked_at = now()
     where revoked_at is null;
  end if;
end
$$;

-- 3. Ask SAR daily usage — only in the Operational DB (the project whose
--    scheduler tables SAR reads; the Edge Function's database).
do $$
begin
  if to_regclass('public.sched_sessions') is not null then
    create table if not exists public.sar2_ask_usage (
      user_id uuid   not null,
      day     date   not null,
      calls   int    not null default 0 check (calls >= 0),
      chars   bigint not null default 0 check (chars >= 0),
      primary key (user_id, day)
    );
    comment on table public.sar2_ask_usage is
      'SAR 2.0 Ask SAR daily allowance: questions and input characters per account per Pacific day. '
      'RLS on, no policies; written only by the sar2-api Edge Function.';
    alter table public.sar2_ask_usage enable row level security;
    revoke all on public.sar2_ask_usage from public, anon, authenticated;
  end if;
end
$$;

commit;
