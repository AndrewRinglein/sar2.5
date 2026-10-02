/* ============================================================================
   SAR 2.0 — "Merged names": the owner's name rule, listed for review

   Shared by Managers and Staff › Worked. Takes `crew.names` (crew-model
   `buildNameMerge`) and lists every merge and every ambiguous bare first name,
   with how often each spelling was used, so the owner can check the rule did
   what was meant and name exceptions (config OWNER_NAME_KEEP_APART and
   OWNER_NAME_ALIASES).
   ========================================================================== */

import { int, esc, dateShort } from '../lib/fmt.js';

const STATUS = {
  merged: 'Merged',
  ambiguous: 'Ambiguous — not merged',
  'kept apart': 'Kept apart by the owner',
};

const SOURCE = { validator: 'validator', scheduler: 'scheduler' };

/** "2 Oct 2026" from '2026-10-02'. */
const confirmedOn = (d) => (d ? `${dateShort(d)} ${String(d).slice(0, 4)}` : '');

/**
 * A collapsed <details> panel. `names` may be null (no crew model yet), in which
 * case nothing is rendered and null is returned.
 */
export function nameMergePanel(names, { cls = 'panel' } = {}) {
  if (!names) return null;
  const rows = names.table ?? [];
  const when = confirmedOn(names.rule?.confirmed);
  const except = (names.except ?? []).join(', ') || 'none';
  const panel = document.createElement('section');
  panel.className = `${cls} nm-panel`;
  const d = document.createElement('details');
  d.className = 'fc-details';
  const c = names.counts ?? {};
  const summary = document.createElement('summary');
  summary.className = 'semi';
  summary.textContent = `Merged names (owner rule${when ? `, ${when}` : ''}) · ${int(c.merged ?? 0)} merged, ${
    int(c.ambiguous ?? 0)} ambiguous${c.keptApart ? `, ${int(c.keptApart)} kept apart` : ''}`;
  d.append(summary);

  const note = document.createElement('p');
  note.className = 'muted so-small';
  note.innerHTML = names.rule?.mergeByFirstName
    ? `The owner confirmed${when ? ` on ${esc(when)}` : ''} that in every role except ${esc(except)} there are no
      duplicate names: "Sam", "Sam O." and "Sam Ortiz" are one person, shown under the fullest
      form, whether typed in the validator or named in the scheduler. Different initials are different
      people — "Jamie Cole" and "Jamie Gray" — and a bare first name that could be either is left as its
      own name and listed as ambiguous. ${esc(except)} entries are never merged: a person's ${esc(except)}
      entries stay under the name as typed even when their other entries merge. Counts are crew entries
      in the validator and sessions in the scheduler.`
    : 'The owner\'s name rule is switched off; only explicit owner aliases are applied.';
  d.append(note);

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No names needed merging.';
    d.append(p);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'so-scroll';
    const t = document.createElement('table');
    t.className = 'rn-table';
    t.innerHTML = `<thead><tr><th class="name">Person</th><th class="name">Spellings</th>
      <th class="name">Status</th></tr></thead><tbody></tbody>`;
    const body = t.querySelector('tbody');
    for (const r of rows) {
      const variants = r.variants.map((v) => `${esc(v.name)} <span class="dim">· ${SOURCE[v.source] ?? esc(v.source)} ·
        ${v.roles.map(esc).join(', ')} · ${int(v.count)}${v.alias ? ' · owner alias' : ''}</span>`).join('<br>');
      const status = r.status === 'ambiguous' && r.candidates?.length
        ? `${STATUS.ambiguous}<br><span class="dim">could be ${r.candidates.map(esc).join(' or ')}</span>`
        : (STATUS[r.status] ?? esc(r.status));
      body.insertAdjacentHTML('beforeend', `<tr class="${r.status === 'ambiguous' ? 'is-flagged' : ''}">
        <td class="name"><strong>${esc(r.canonical)}</strong></td>
        <td class="name">${variants}</td><td class="name">${status}</td></tr>`);
    }
    wrap.append(t);
    d.append(wrap);
  }
  const how = document.createElement('p');
  how.className = 'muted so-small';
  how.textContent = 'To mark two names as different people, or to join a name the rule left ambiguous, '
    + 'the owner\'s exceptions are recorded in the configuration (keep apart, and aliases).';
  d.append(how);
  panel.append(d);
  return panel;
}
