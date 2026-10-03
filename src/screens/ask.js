// Ask SAR uses the shared server-side credential. Users only ask questions.
import { metricsFor, sessionTotals } from '../lib/model.js';
import { monthSeries, monthFull, hallMatches } from '../lib/charts.js';
import { usd, pct, int, esc, DASH } from '../lib/fmt.js';
import { play } from '../lib/sound.js';
import { serverRequest } from '../lib/server-request.js';
import { MAX_CONTEXT_CHARS, MAX_HISTORY_TURNS, MAX_HISTORY_CHARS } from '../lib/ask-limits.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

/* ---------------------------------------------------------------------------
   The payload
--------------------------------------------------------------------------- */

const dollars = (cents) => +((cents ?? 0) / 100).toFixed(2);
const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : +x.toFixed(2));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = (e) => e.day_of_week
  ? String(e.day_of_week).slice(0, 3)
  : WEEKDAYS[new Date(`${String(e.event_date).slice(0, 10)}T12:00:00Z`).getUTCDay()];

/**
 * What gets sent: every session as one compact row, plus summaries the app
 * computes from the same rows, so the answer service never has to guess at a
 * total. No names of any kind — not staff, not managers, not runners.
 * Hall names and product category names are the only labels.
 */
export function buildContext(data, { hall = 'all', months = 24 } = {}) {
  const hallName = new Map((data.locations ?? []).map((l) => [l.id, l.name]));
  const halls = (data.locations ?? []).map((l) => l.name);
  const cats = data.categories ?? [];
  const categories = cats.map((c) => c.display_name);
  const jackpotsCfg = (data.config?.settings?.jackpots ?? []).map((jp) => ({
    name: jp.name, cap: dollars(jp.cap), participation: dollars(jp.participation),
    scope: jp.scope === 'org_wide' ? 'shared by both halls' : 'per hall',
    balanceKey: jp.balanceKey, paidKey: jp.paidKey,
  }));
  const metricsOf = (e) => metricsFor(e.id, data.metrics, data.idx);

  const columns = ['date', 'hall', 'type', 'weekday', 'attendance', 'gross', 'payouts', 'net', 'marginPct', 'rpa',
    ...categories.map((c) => `${c} net`),
    ...jackpotsCfg.map((jp) => `${jp.name} balance`), ...jackpotsCfg.map((jp) => `${jp.name} paid`),
    'Gremlin paid'];
  const events = [...(data.events ?? [])]
    .filter((e) => hall === 'all' || hallMatches(hall, e.location_id))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  const rows = [];
  const profile = new Map();
  const latestBalance = new Map();
  const lastPaid = new Map();
  const latest = events.length ? String(events[events.length - 1].event_date).slice(0, 10) : null;
  const yearAgo = latest ? new Date(`${latest}T12:00:00Z`) : null;
  if (yearAgo) yearAgo.setUTCDate(yearAgo.getUTCDate() - 365);
  const cutoff = yearAgo ? yearAgo.toISOString().slice(0, 10) : null;

  for (const e of events) {
    const m = metricsOf(e);
    const t = sessionTotals(m, cats);
    const name = hallName.get(e.location_id) ?? 'Unknown hall';
    const type = e.event_type ?? 'regular';
    const wd = weekdayOf(e);
    const date = String(e.event_date).slice(0, 10);
    const row = [date, name, type, wd, t.attendance, dollars(t.revenue), dollars(t.payout), dollars(t.net),
      t.margin === null ? null : r2(t.margin * 100), t.rpa === null ? null : dollars(t.rpa),
      ...t.categories.map((c) => dollars(c.net))];
    for (const jp of jackpotsCfg) {
      const bal = Number(m[jp.balanceKey] ?? 0);
      row.push(bal ? dollars(bal) : null);
      if (bal) latestBalance.set(`${jp.name}|${name}`, { date, balance: dollars(bal) });
    }
    for (const jp of jackpotsCfg) {
      const paid = Math.abs(Number(m[jp.paidKey] ?? 0));
      row.push(paid ? dollars(paid) : null);
      if (paid) lastPaid.set(jp.name, { date, hall: name, amount: dollars(paid) });
    }
    const gremlin = Math.abs(Number(m.gremlin_hotball ?? 0));
    row.push(gremlin ? dollars(gremlin) : null);
    rows.push(row);

    if (!cutoff || date >= cutoff) {
      const key = `${name}|${wd}|${type}`;
      const p = profile.get(key) ?? { hall: name, weekday: wd, type, sessions: 0, gross: 0, net: 0, attendance: 0 };
      p.sessions++; p.gross += t.revenue; p.net += t.net; p.attendance += t.attendance ?? 0;
      profile.set(key, p);
    }
  }

  const monthRows = (h) => monthSeries(data.events, data, { hall: h }).slice(-months).map((m) => ({
    month: m.key, sessions: m.eventCount, gross: dollars(m.gross), payouts: dollars(m.payout),
    net: dollars(m.net), attendance: m.attendance,
    marginPct: m.margin === null ? null : r2(m.margin * 100),
    byCategory: Object.fromEntries(m.categoryList.map((c) => [c.name, dollars(c.net)])),
  }));

  return {
    business: 'Two charity bingo halls run by one nonprofit. Money is US dollars. "type" is regular or late (a second session the same day).',
    halls,
    categories,
    sessionCount: events.length,
    span: events.length ? { from: String(events[0].event_date).slice(0, 10), to: latest } : null,
    columns,
    sessions: rows,
    monthly: monthRows('combined'),
    monthlyByHall: Object.fromEntries((data.locations ?? []).map((l) => [l.name, monthRows(l.id)])),
    weekdayProfile: {
      period: cutoff ? `${cutoff} to ${latest}` : null,
      note: 'Averages per session over the last 365 days of data, by hall, weekday and session type. Compare a session with its own line here, not across lines.',
      rows: [...profile.values()].map((p) => ({
        hall: p.hall, weekday: p.weekday, type: p.type, sessions: p.sessions,
        avgGross: dollars(p.gross / p.sessions), avgNet: dollars(p.net / p.sessions),
        avgAttendance: r2(p.attendance / p.sessions),
      })),
    },
    jackpots: {
      configured: jackpotsCfg.map(({ balanceKey, paidKey, ...jp }) => jp),
      latestBalance: [...latestBalance.entries()].map(([k, v]) => ({ jackpot: k.split('|')[0], hall: k.split('|')[1], ...v })),
      lastPaid: [...lastPaid.entries()].map(([jackpot, v]) => ({ jackpot, ...v })),
      note: 'A paid amount on a row means that jackpot hit that session. Gremlin is a payout only; it has no balance.',
    },
    // Kept for older readers of the payload.
    months: monthRows('combined'),
  };
}

/**
 * The package as sent: within the server's MAX_CONTEXT_CHARS.
 *
 * Today's ~900 sessions are well inside the cap (see ask-limits.js). When the
 * history eventually outgrows it, the OLDEST session rows are left out — the
 * monthly and weekday summaries still cover the whole span — and the package
 * says so, rather than the question being refused by the server.
 */
export function fitContext(context, max = MAX_CONTEXT_CHARS) {
  const size = JSON.stringify(context).length;
  if (size <= max) return context;
  const rows = context.sessions ?? [];
  const note = 'Older session rows were left out to keep the request within its size limit; '
    + 'the monthly and weekday summaries still cover every session.';
  let room = max - JSON.stringify({ ...context, sessions: [], sessionsNote: note,
    sessionCount: rows.length, span: context.span }).length - 64;
  let from = rows.length;
  while (from > 0) {
    const len = JSON.stringify(rows[from - 1]).length + 1;
    if (len > room) break;
    room -= len; from -= 1;
  }
  const kept = rows.slice(from);
  return { ...context, sessions: kept, sessionsNote: note,
    span: context.span && kept.length ? { from: kept[0][0], to: context.span.to } : context.span };
}

/** Recent turns only, newest kept, within the server's history limits. */
export function recentHistory(turns) {
  const out = turns.slice(-MAX_HISTORY_TURNS).map(({ role, content }) => ({ role, content }));
  let total = out.reduce((n, t) => n + t.content.length, 0);
  while (out.length && total > MAX_HISTORY_CHARS) total -= out.shift().content.length;
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** Conversation memory for follow-up questions. Lives for the browser session. */
export const conversation = [];
export function resetConversation() { conversation.length = 0; }

/** The browser sends its SAR session, a question, the data and recent turns; never a provider key. */
export async function askClaude({ question, context, history = [], request = serverRequest }) {
  if (!question?.trim()) return { ok: false, error: 'Ask something first.' };
  try {
    return await request('/api/ask-sar', { body: { question: question.trim(), context, history } });
  } catch {
    return { ok: false, error: 'Ask SAR is temporarily unavailable. Please try again later.' };
  }
}

/** Split a trailing "Basis: …" line off an answer so it can be shown quietly. */
export function splitBasis(text) {
  const m = /\n\s*(Basis:\s*[^\n]*)\s*$/i.exec(text ?? '');
  if (!m) return { answer: (text ?? '').trim(), basis: null };
  return { answer: text.slice(0, m.index).trim(), basis: m[1].trim() };
}

/* ---------------------------------------------------------------------------
   The offline answerer
--------------------------------------------------------------------------- */

/**
 * Answer the common questions without a key, from the data already loaded.
 *
 * Deliberately narrow. It matches a few real shapes and otherwise says it
 * cannot — a parser that guesses would be worse than no parser, because a
 * confident wrong answer about money is the one failure that matters.
 */
export function answerLocally(question, data) {
  const q = String(question ?? '').toLowerCase().trim();
  if (!q) return null;
  const rows = monthSeries(data.events, data);
  if (!rows.length) return { text: 'No sessions are loaded.' };

  const last = rows[rows.length - 1];
  const cats = data.categories ?? [];

  /* Which measure is being asked about. NET IS CHECKED FIRST and gross last:
     "best month for net" contains both "month" and "net", and an earlier
     version matched the gross branch and confidently answered the wrong
     question. A wrong number stated confidently is the one failure that
     actually matters here. */
  const measure = /\bnet\b/.test(q) ? { key: 'net', label: 'net' }
    : /\battendance\b/.test(q) ? { key: 'attendance', label: 'attendance' }
      : { key: 'gross', label: 'gross' };

  const fmt = (v) => (measure.key === 'attendance' ? int(v) : usd(v));

  if (/\b(best|highest|biggest|top)\b/.test(q)) {
    const top = [...rows].sort((a, b) => b[measure.key] - a[measure.key])[0];
    return { text: `The best month for ${measure.label} was ${monthFull(top.key)} at `
      + `${fmt(top[measure.key])}, across ${top.eventCount} sessions.` };
  }
  if (/\b(worst|lowest|weakest)\b/.test(q)) {
    const low = [...rows].sort((a, b) => a[measure.key] - b[measure.key])[0];
    return { text: `The lowest month for ${measure.label} was ${monthFull(low.key)} at `
      + `${fmt(low[measure.key])}, across ${low.eventCount} sessions.` };
  }

  /* Which category earns most — asked as a comparison, so it is answered as
     one, over the whole loaded period rather than one month. */
  if (/\bcategor|\bproduct\b/.test(q) && cats.length) {
    const totals = new Map();
    for (const m of rows) {
      for (const c of m.categoryList) {
        totals.set(c.name, (totals.get(c.name) ?? 0) + c.net);
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length) {
      const [name, net] = ranked[0];
      const rest = ranked.slice(1, 4).map(([n, v]) => `${n} ${usd(v)}`).join(', ');
      return { text: `${name} earns the most, netting ${usd(net)} across the `
        + `${rows.length} months loaded${rest ? `. Then ${rest}` : ''}.` };
    }
  }

  /* A named category. Checked after the comparison so "which category" is not
     swallowed by a category whose name happens to appear in the question. */
  for (const c of cats) {
    if (q.includes(c.display_name.toLowerCase())) {
      const v = last.categories.get(c.key);
      if (!v) break;
      return { text: `${c.display_name} in ${monthFull(last.key)}: ${usd(v.revenue)} `
        + `of sales and ${usd(v.payout)} of payouts, netting ${usd(v.net)}.` };
    }
  }

  if (/\btrend|\bgrow|\bshrink|\bdirection\b/.test(q)) {
    const half = Math.floor(rows.length / 2);
    if (half >= 1) {
      const mean = (xs) => xs.reduce((s, m) => s + m[measure.key], 0) / xs.length;
      const older = mean(rows.slice(0, half));
      const newer = mean(rows.slice(half));
      const change = older > 0 ? (newer - older) / older : null;
      return { text: `${measure.label[0].toUpperCase()}${measure.label.slice(1)} is `
        + `${change === null ? 'not comparable' : change >= 0 ? 'up' : 'down'}`
        + `${change === null ? '' : ` ${pct(Math.abs(change))}`} comparing the most `
        + `recent ${rows.length - half} months against the previous ${half}.` };
    }
  }

  if (/\bmargin\b/.test(q)) {
    return { text: `Margin last month (${monthFull(last.key)}) was `
      + `${last.margin === null ? 'not computable' : pct(last.margin)}, on `
      + `${usd(last.gross)} gross and ${usd(last.payout)} of payouts.` };
  }
  if (/\battendance\b/.test(q)) {
    return { text: `Attendance in ${monthFull(last.key)} was ${int(last.attendance)} `
      + `across ${last.eventCount} sessions, averaging `
      + `${int(Math.round(last.attendance / Math.max(1, last.eventCount)))} a session.` };
  }
  if (/\b(last|this)\s+month\b/.test(q) || /\bhow.*(doing|going|go)\b/.test(q)) {
    return { text: `${monthFull(last.key)}: ${usd(last.gross)} gross, `
      + `${usd(last.net)} net from ${last.eventCount} sessions, margin `
      + `${last.margin === null ? DASH : pct(last.margin)}.` };
  }
  return null;
}

export const SUGGESTIONS = Object.freeze([
  'How did last month go?',
  'What was our best month for net?',
  'What is our margin trending like?',
  'Which product category makes the most money?',
  'Is attendance growing or shrinking?',
]);

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderAsk({ data, params, setInspectorContent }) {
  // Remove a credential saved by the old browser-key interface, if present.
  try { globalThis.localStorage?.removeItem('sar2-anthropic-key'); } catch { /* storage unavailable */ }
  const root = h('div', 'screen');
  const context = fitContext(buildContext(data));
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Ask SAR'));
  panel.append(h('p', 'muted', `Ask about any session, hall, weekday, month, product or jackpot. ${int(context.sessionCount)} sessions are loaded. Follow-up questions remember the conversation.`));
  const ask = h('form', 'ask-form');
  ask.innerHTML = '<label class="sr-only" for="q">Your question</label>'
    + '<input id="q" type="text" maxlength="2000" placeholder="Ask about the halls…" aria-label="Your question about the halls">'
    + '<button class="primary" type="submit">Ask</button>'
    + '<button class="chip" type="button" id="ask-reset">New conversation</button>';
  ask.querySelector('#q').value = params.q ?? '';
  const out = h('div', 'ask-out');
  out.setAttribute('role', 'status');
  out.setAttribute('aria-live', 'polite');
  const turn = (role, text, basis = null, note = null) => {
    const el = h('div', `ask-turn ask-${role}`);
    const who = h('p', 'dim'); who.textContent = role === 'user' ? 'You' : 'Ask SAR';
    const body = h('p', role === 'user' ? 'ask-question' : 'ask-answer'); body.textContent = text;
    el.append(who, body);
    if (basis) { const b = h('p', 'dim ask-basis'); b.textContent = basis; el.append(b); }
    if (note) { const n = h('p', 'dim'); n.textContent = note; el.append(n); }
    return el;
  };
  const redraw = () => {
    out.replaceChildren();
    for (const t of conversation) out.append(turn(t.role, t.shown ?? t.content, t.basis, t.note));
  };
  redraw();
  let busy = false;
  const run = async question => {
    if (busy || !question.trim()) return;
    busy = true;
    for (const b of panel.querySelectorAll('button')) b.disabled = true;
    const history = recentHistory(conversation);
    conversation.push({ role: 'user', content: question.trim() });
    redraw();
    const thinking = h('p', 'dim'); thinking.textContent = 'Thinking…'; out.append(thinking);
    try {
      const result = await askClaude({ question, context, history });
      if (result.ok) {
        const { answer, basis } = splitBasis(result.text);
        conversation.push({ role: 'assistant', content: result.text, shown: answer, basis });
      } else {
        const local = answerLocally(question, data);
        conversation.push({ role: 'assistant', content: local?.text ?? result.error, shown: local?.text ?? result.error,
          note: local ? 'Answered from the loaded totals while Ask SAR is unavailable.' : null });
      }
      redraw();
      ask.querySelector('#q').value = '';
    } finally {
      busy = false;
      for (const b of panel.querySelectorAll('button')) b.disabled = false;
    }
  };
  ask.addEventListener('submit', ev => {
    ev.preventDefault(); play('select'); run(ask.querySelector('#q').value);
  });
  ask.querySelector('#ask-reset').addEventListener('click', () => { resetConversation(); redraw(); });
  panel.append(ask, out);
  const suggestions = h('div', 'filter-bar');
  for (const text of SUGGESTIONS) {
    const button = h('button', 'chip');
    button.type = 'button'; button.textContent = text;
    button.addEventListener('click', () => { ask.querySelector('#q').value = text; run(text); });
    suggestions.append(button);
  }
  panel.append(suggestions);
  root.append(panel);
  const detail = h('details', 'panel');
  detail.append(h('summary', 'panel-title', 'Data used for answers'));
  detail.append(h('p', 'muted', `Your question, the recent conversation and a data package are sent to the answer service: `
    + `${int(context.sessionCount)} session rows (${context.columns.length} columns each), monthly totals per hall, `
    + `weekday averages and jackpot state. No staff, runner or customer records are included. `
    + `The bingo knowledge file (knowledge/bingo-knowledge.md) is added by the server.`));
  const pre = h('pre', 'ask-payload');
  pre.setAttribute('data-raw', 'json');
  const { sessions, ...summaries } = context;
  pre.textContent = JSON.stringify({ ...summaries, sessions: `[${sessions.length} rows omitted here]` }, null, 2);
  detail.append(pre);
  root.append(detail);
  setInspectorContent?.('<p class="semi">Ask SAR</p>'
    + `<p class="muted">${int(context.sessionCount)} sessions loaded${context.span ? `, ${esc(context.span.from)} to ${esc(context.span.to)}` : ''}.</p>`
    + '<p class="inspector-section-label">Scope</p>'
    + '<p class="muted">Every session with its revenue, payouts, net, attendance, product categories and jackpots; monthly totals per hall; weekday averages. Staff and wage details are not included.</p>'
    + '<p class="inspector-section-label">Knowledge</p>'
    + '<p class="muted">Edit <code>knowledge/bingo-knowledge.md</code> in the app folder to teach Ask SAR about your halls. It is read on every question.</p>');
  return root;
}
