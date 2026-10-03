/* ============================================================================
   SAR 2.0 — Ask SAR cost limits

   Every number that bounds what one signed-in account can make Ask SAR spend
   is here, and nowhere else. The server (server/api-core.mjs) enforces them;
   the browser (src/screens/ask.js) reads the same values so it never builds a
   request the server would refuse.
   ========================================================================== */

/*
 * MAX_CONTEXT_CHARS: the data package the browser builds (src/screens/ask.js
 * buildContext) was MEASURED, not guessed, on a production-shaped bundle — two
 * halls, five product categories, two jackpots plus the Gremlin, 20 columns
 * per session row:
 *     300 sessions ~  61 KB     900 sessions ~ 170 KB
 *    1500 sessions ~ 266 KB    2000 sessions ~ 346 KB
 * i.e. ~160-190 bytes per session plus a fixed ~15 KB of monthly summaries
 * (bounded at 24 months). Production has ~880 sessions today and adds ~350 a
 * year, so 450,000 characters is ~2.6x today's real payload: room for about
 * 2,500 sessions (roughly five more years) before the browser starts leaving
 * out the oldest sessions (fitContext in ask.js), while a hand-crafted
 * multi-megabyte "context" is refused.
 * Characters of the serialized JSON are what the model is billed on (as
 * tokens), so that is what is counted, not bytes.
 *
 * MAX_BODY_BYTES: the whole request — context + question (2,000) + history —
 * with headroom for JSON escaping and multi-byte characters. Anything larger
 * is refused with 413 before it is parsed.
 *
 * MAX_HISTORY_CHARS: follow-up turns are kept newest first until this many
 * characters; older turns are dropped (an answer is at most ~1,200 tokens, so
 * this keeps roughly the last four exchanges).
 *
 * ASK_DAILY_CALLS / ASK_DAILY_CHARS: the per-account daily quota. 100 questions
 * and 3,000,000 input characters a day (about 17 full-context questions at
 * today's 170 KB; follow-ups in the same sitting are mostly cache reads). The
 * day is the Pacific calendar day, the halls' own.
 */
export const MAX_CONTEXT_CHARS = 450000;
export const MAX_BODY_BYTES = 600000;
export const MAX_HISTORY_TURNS = 12;
export const MAX_HISTORY_CHARS = 30000;
export const ASK_DAILY_CALLS = 100;
export const ASK_DAILY_CHARS = 3000000;

/** Ask SAR calls allowed per verified account per minute (burst control). */
export const ASK_LIMIT_PER_MINUTE = 10;

/** The day a quota is counted against: the halls' (Pacific) calendar day. */
export const ASK_TIME_ZONE = 'America/Los_Angeles';

