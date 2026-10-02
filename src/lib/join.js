/* ============================================================================
   SAR 2.0 — join.js is RETIRED. Do not add anything here.

   This module used to export its own `joinSessions`, matching Ops sessions to
   analytics events through a STATIC `part -> event_type` lookup table. Nothing
   ever imported it, and it was wrong:

     · `PM -> late` fails on a weekday, where the single session is called `PM`
       by the roster and `regular` by the analytics
     · `PM -> late` also fails for Redwood City, which runs one session a night
       recorded as `regular` and rostered as `PM` — every night of it would be
       sent to a slot that does not exist

   The live implementation is `lib/managers.js`, which matches by ORDINAL
   POSITION within the day and skips any day whose two sides disagree on how
   many sessions there were. It is verified against production and documented
   in SAR2-MANAGERS-DESIGN.md §2.

   The danger was two exported functions with the SAME NAME, the same apparent
   purpose and opposite algorithms, in one project. Importing the wrong one
   produced different answers with no error. So this file now re-exports the
   correct implementation and exports nothing of its own — there is one
   `joinSessions` and it cannot be got wrong.
   ========================================================================== */

export {
  joinSessions,
  resolveHalls,
  attributeManagers,
  dayNumber,
  weekdayIndex,
} from './managers.js';

/** Kept so a stale import fails loudly instead of silently doing nothing. */
export function partToEventType() {
  throw new Error(
    'partToEventType has been removed: a static part->event_type map is wrong on '
    + 'weekdays and at Redwood City. Use joinSessions from lib/managers.js, which '
    + 'matches by position within the day.',
  );
}
