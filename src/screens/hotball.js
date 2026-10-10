/* ============================================================================
   SAR 2.0 — Hotball pots

   The three hotball pots night by night: opening, added, pot drop, pot after,
   and every night a pot dropped. Built from the "Hotball Pots: Developer
   Handoff" (9 Oct 2026); the numbers come from src/lib/hotball-model.js,
   which reproduces the handoff's reference SQL row for row.

   READ-ONLY. Cash movements are recorded in Session Reconciliation's hotball
   page; SAR shows them and applies them to the chain, and never writes.

   Words: a POT DROP, never "paid out" — the halls do not know that every drop
   was a winner. "Paid box" is the box the paymaster types into on the night.

   STATE lives in the route params:
     pot   mega | rwc_hotball | sc_hotball    the pot whose ledger is shown
   ========================================================================== */

import { buildHotball, MOVEMENT_KINDS } from '../lib/hotball-model.js';
import { usd, int, dateLong, dateShort, esc, DASH } from '../lib/fmt.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

/** The model works in dollars; the formatter takes cents. */
const money = (d) => (d === null || d === undefined ? DASH : usd(Math.round(d * 100)));
const signed = (d) => (d > 0 ? `+${money(d)}` : d < 0 ? `−${money(-d)}` : money(0));
const part = (time) => (time && time < '17:00' ? 'afternoon' : 'night');
const when = (r) => `${r.hall} ${dateShort(r.date)} ${part(r.time)}`;

/**
 * Pot size over the chain. Each pot drop is a short vertical stroke from the
 * pot size down to the pot after, so its length is the drop. Stretched to the
 * panel's width; strokes keep their weight however wide that is.
 */
function potTrend(rows) {
  const W = 1000; const H = 64; const P = 3;
  const top = Math.max(...rows.map((r) => r.total), 1);
  const x = (i) => (rows.length < 2 ? P : (i / (rows.length - 1)) * (W - P * 2) + P);
  const y = (v) => H - P - (v / top) * (H - P * 2);
  const path = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.total).toFixed(1)}`).join(' ');
  const marks = rows.map((r, i) => (r.drop > 0
    ? `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(r.total).toFixed(1)}"
             y2="${y(r.potAfter).toFixed(1)}" stroke="var(--neg)" stroke-width="2.5"
             vector-effect="non-scaling-stroke"><title>Pot drop ${esc(when(r))}: ${money(r.drop)}</title></line>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="jp-spark hb-spark" role="img"
               aria-label="Pot size over time; red strokes are pot drops">
    <path d="${path}" fill="none" stroke="var(--gold)" stroke-width="1.5" vector-effect="non-scaling-stroke"
          stroke-linejoin="round" stroke-linecap="round"/>${marks}</svg>
    <p class="dim hb-foot" style="margin-top:var(--s-1)">Oldest to newest. Red strokes are pot drops.</p>`;
}

function potCard(pot, active, onPick) {
  const card = h('button', `hb-card${active ? ' is-active' : ''}`);
  card.type = 'button';
  card.dataset.pot = pot.key;
  const last = pot.asOf;
  const drop = pot.lastDrop;
  card.innerHTML = `
    <span class="kpi-label">${esc(pot.label)}</span>
    <span class="hb-scope dim">${pot.shared ? 'one pot, both halls' : `${esc(last?.hall ?? '')} only`}</span>
    <span class="kpi-value">${money(pot.now)}</span>
    <span class="kpi-sub dim">as of ${last ? esc(`${last.hall} ${dateLong(last.date)} ${part(last.time)}`) : DASH}</span>
    <dl class="hb-stats">
      <dt>Last pot drop</dt><dd>${drop ? `${money(drop.drop)}, ${esc(when(drop))}` : 'none yet'}</dd>
      <dt>Sessions since</dt><dd>${drop ? int(pot.sessionsSince) : DASH}</dd>
      <dt>Added since</dt><dd>${drop ? money(pot.addedSince) : DASH}</dd>
      ${pot.count ? `<dt>Envelope count</dt><dd>${money(pot.count.amount)}
        <span class="${pot.count.overShort < 0 ? 'tone-neg' : pot.count.overShort > 0 ? 'tone-pos' : 'dim'}">
        (${pot.count.overShort === 0 ? 'matches' : `${signed(pot.count.overShort)} ${pot.count.overShort > 0 ? 'over' : 'short'}`})</span></dd>` : ''}
    </dl>`;
  card.addEventListener('click', () => onPick(pot.key));
  return card;
}

function dropsPanel(model) {
  const panel = h('section', 'panel');
  panel.dataset.section = 'drops';
  panel.append(h('h3', 'panel-title', 'Pot drops'));
  if (!model.drops.length) {
    panel.append(h('p', 'dim', 'No pot has dropped yet.'));
    return panel;
  }
  const wrap = h('div', 'hb-scroll');
  const table = h('table', 'cat-table');
  table.innerHTML = `<thead><tr><th class="name">Night</th><th class="name">Pot</th>
    <th>Pot before</th><th>Pot drop</th><th class="name">Basis</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector('tbody');
  for (const r of model.drops) {
    body.insertAdjacentHTML('beforeend', `<tr>
      <td class="name">${esc(when(r))}</td><td class="name">${esc(r.potLabel)}</td>
      <td>${money(r.total)}</td><td class="tone-neg">${money(r.drop)}</td>
      <td class="name dim">${esc(r.basis)}</td></tr>`);
  }
  body.insertAdjacentHTML('beforeend', `<tr class="total-row">
    <td class="name">${int(model.drops.length)} pot drop${model.drops.length === 1 ? '' : 's'}</td>
    <td></td><td></td><td>${money(model.totalDropped)}</td><td></td></tr>`);
  wrap.append(table);
  panel.append(wrap);
  panel.append(h('p', 'dim hb-foot',
    'A pot drop is what the Paid box shows, or where the next night opened lower than this '
    + 'night\'s pot. The Basis column says which. Drops found from a lower opening are '
    + 'counted automatically; nobody confirmed them as winners.'));
  return panel;
}

function ledgerPanel(pot) {
  const panel = h('section', 'panel');
  panel.dataset.section = 'ledger';
  panel.append(h('h3', 'panel-title', `${esc(pot.label)} · night by night`));
  if (pot.rows.length > 1) panel.insertAdjacentHTML('beforeend', potTrend(pot.rows));

  const wrap = h('div', 'hb-scroll hb-scroll-tall');
  const table = h('table', 'cat-table hb-ledger');
  table.innerHTML = `<thead><tr><th class="name">Night</th><th>Opening</th><th>Added</th>
    <th>Pot size</th><th>Paid box</th><th>Pot drop</th><th>Pot after</th>
    <th>Next opens</th><th class="name">Note</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector('tbody');
  for (const r of [...pot.rows].reverse()) {
    const moves = r.moves.map((m) => `${MOVEMENT_KINDS[m.kind].label} ${money(m.amount)}${
      m.note ? ` (${m.note})` : ''}`);
    const counts = r.counts.map((m) => `Envelope count ${money(m.amount)}`);
    const notes = [...r.notes, ...moves, ...counts];
    if (r.status === 'open' && r === pot.rows.at(-1)) notes.unshift('Session still open; figures may change');
    let gap;
    if (r.gap === null) gap = '<span class="dim">latest</span>';
    else if (r.balanced) gap = '<span class="dim">balanced</span>';
    else gap = `<span class="${r.gap < 0 ? 'tone-neg' : 'tone-pos'}">${signed(r.gap)}</span>`;
    const tr = h('tr');
    tr.dataset.key = `${r.potKey}|${r.date}|${r.time}`;
    if (r.drop > 0) tr.className = 'hb-dropped';
    tr.innerHTML = `
      <td class="name">${esc(`${r.hall} ${dateLong(r.date)} ${part(r.time)}`)}</td>
      <td>${money(r.opening)}</td><td>${money(r.added)}</td><td>${money(r.total)}</td>
      <td>${r.paidKeyed > 0 ? money(r.paidKeyed) : '<span class="dim">—</span>'}</td>
      <td>${r.drop > 0 ? `<span class="tone-neg">${money(r.drop)}</span>` : '<span class="dim">—</span>'}</td>
      <td>${money(r.potAfter)}</td><td>${gap}</td>
      <td class="name hb-note">${notes.map((n) => esc(n)).join('<br>')}</td>`;
    body.append(tr);
  }
  wrap.append(table);
  panel.append(wrap);
  panel.append(h('p', 'dim hb-foot',
    'Pot after is the pot size less the pot drop. Next opens is the next session\'s opening '
    + 'less this one\'s closing: zero means the two agree. Cash movements recorded in Session '
    + 'Reconciliation are applied to the night they belong to.'));
  return panel;
}

export function renderHotball({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const hb = data.schedule?.ok ? data.schedule.hotball : null;

  if (!hb?.ok) {
    root.append(h('section', 'panel', `
      <h3 class="panel-title">Hotball pots</h3>
      <div class="placeholder"><p class="semi">Hotball pots not connected</p>
      <p class="dim">The pots come from Session Reconciliation through Operations, which is
      temporarily unavailable. Please try again later.</p></div>`));
    return root;
  }

  const model = buildHotball({ rows: hb.rows, movements: hb.movements });
  if (!model.pots.length) {
    root.append(h('div', 'placeholder',
      '<p class="semi">No reconciled sessions yet</p>'
      + '<p class="dim">Pots appear once Session Reconciliation saves a night.</p>'));
    return root;
  }

  const pot = model.pots.find((p) => p.key === params.pot) ?? model.pots[0];
  const pick = (key) => onNavigate('hotball', { ...params, pot: key });

  if (!hb.movementsOk) {
    root.append(h('div', 'mg-notice',
      'Cash movements could not be read, so every night is shown as Session Reconciliation saved it.'));
  }

  const cards = h('div', 'hb-cards');
  for (const p of model.pots) cards.append(potCard(p, p.key === pot.key, pick));
  root.append(cards);
  root.append(dropsPanel(model));
  root.append(ledgerPanel(pot));

  const moved = hb.movements.length;
  setInspectorContent?.(`
    <p class="semi">Hotball pots</p>
    <p class="muted">${int(model.sessions)} reconciled sessions · ${int(moved)} cash movement${moved === 1 ? '' : 's'}</p>
    <p class="inspector-section-label">Pot drop</p>
    <p class="muted">If the next night opens lower than the pot the night before, the pot
      dropped by the difference after that earlier night. It is called a pot drop because
      the halls do not know that every drop was a winner.</p>
    <p class="inspector-section-label">Not counted as drops</p>
    <p class="muted">Gaps into or out of a session that opened on the app's built-in default
      (before 19 Aug 2026); a session whose additions were skipped because the next one opened
      on an older closing, and the later raise that restores them; and a raise the next
      opening takes straight back. Each is noted on its night.</p>
    <p class="inspector-section-label">Mega Hotball</p>
    <p class="muted">One pot shared by both halls, so a drop at either hall lowers it for both
      and its nights interleave the two halls.</p>
    <p class="inspector-section-label">Source</p>
    <p class="muted">Session Reconciliation's saved hotball ledger and, for the Mega pot, the
      Paid box as typed, which the ledger does not always keep. SAR only reads these.</p>`);

  return root;
}
