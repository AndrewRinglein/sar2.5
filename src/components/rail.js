/* ============================================================================
   SAR 2.0 — the left rail

   The one dark region in the product. Nav items are generated from
   `router.NAV`, so a screen cannot exist in the rail without existing as a
   route, and vice versa.

   EXACTLY ONE ITEM IS EVER MARKED ACTIVE. SPEC §18 records that SAR 1.0
   highlighted four at once, because saved views carried the same `data-view`
   attribute as real screens and the highlight query matched all of them. Here
   the active id comes from `activeItem()`, which returns one id or null.
   ========================================================================== */

import { NAV, buildHash } from '../lib/router.js';
import { esc } from '../lib/fmt.js';

export function renderRail({ active, customerName, onNavigate } = {}) {
  const rail = document.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Screens');

  const head = document.createElement('div');
  head.className = 'rail-head';
  head.innerHTML = `
    <img src="./vanguard_logo.png" alt="">
    <div>
      <div class="rail-title">SAR</div>
      <div class="rail-sub">${esc(customerName ?? 'Session Analysis Reporting')}</div>
    </div>`;
  rail.append(head);

  for (const group of NAV) {
    const g = document.createElement('div');
    g.className = 'rail-group';

    const h = document.createElement('div');
    h.className = 'rail-group-label';
    h.textContent = group.group;
    g.append(h);

    for (const item of group.items) {
      const a = document.createElement('a');
      a.href = buildHash(item.id);
      a.className = 'rail-item';
      a.textContent = item.label;
      // `data-nav` marks a REAL nav target. Saved views and other links must
      // never carry it — that is the discriminator SAR 1.0 lacked.
      a.dataset.nav = item.id;
      if (item.id === active) {
        a.classList.add('is-active');
        a.setAttribute('aria-current', 'page');
      }
      if (onNavigate) {
        a.addEventListener('click', (e) => { e.preventDefault(); onNavigate(item.id); });
      }
      g.append(a);
    }
    rail.append(g);
  }

  return rail;
}

/**
 * Update the highlight without rebuilding the rail.
 *
 * Rebuilding on every route change would drop scroll position and any focus
 * the keyboard user had. Returns how many items ended up active so a caller —
 * or a test — can assert it is exactly one.
 */
export function setActive(rail, active) {
  let count = 0;
  for (const a of rail.querySelectorAll('[data-nav]')) {
    const on = a.dataset.nav === active;
    a.classList.toggle('is-active', on);
    if (on) { a.setAttribute('aria-current', 'page'); count++; }
    else a.removeAttribute('aria-current');
  }
  return count;
}
