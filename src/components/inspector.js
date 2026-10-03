/* ============================================================================
   SAR 2.0 — the inspector

   A DOCKED COLUMN, NOT AN OVERLAY. This was decided explicitly: an overlay
   covers the content it is describing, which is exactly wrong for a panel
   whose job is to explain what you are looking at.

   It is never empty. With nothing selected it describes the current screen and
   the filters in force, because a blank third of the window reads as broken
   rather than as idle.
   ========================================================================== */

import { esc } from '../lib/fmt.js';

export function renderInspector() {
  const el = document.createElement('aside');
  el.className = 'inspector';
  el.setAttribute('aria-label', 'Inspector');
  el.innerHTML = `
    <div class="inspector-bar">
      <span class="inspector-title">Inspector</span>
      <button class="inspector-toggle" type="button"
              aria-label="Collapse inspector" title="Collapse (\\)">›</button>
    </div>
    <div class="inspector-body"></div>`;
  return el;
}

/** Replace the body. Accepts a node or an HTML string. */
export function setInspector(inspector, content) {
  const body = inspector.querySelector('.inspector-body');
  if (content instanceof Node) body.replaceChildren(content);
  else body.innerHTML = content ?? '';
  return body;
}

/**
 * The empty state — which is not empty.
 *
 * Describes the screen and the filters currently applied, so the panel always
 * earns its width.
 */
export function inspectorIdle({ screenLabel, description, filters = [] } = {}) {
  const rows = filters.length
    ? `<dl class="inspector-filters">${filters
        .map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl>`
    : '<p class="dim">No filters applied.</p>';
  return `
    <p class="semi">${esc(screenLabel)}</p>
    ${description ? `<p class="muted">${esc(description)}</p>` : ''}
    <p class="inspector-section-label">Filters in force</p>
    ${rows}`;
}

/**
 * Collapse handling.
 *
 * `\` toggles, matching the mockups. The key is ignored while focus is in a
 * text field, or typing a backslash into a search box would fold the panel.
 */
export function wireInspector(shell, inspector) {
  const toggle = () => {
    const collapsed = shell.classList.toggle('inspector-collapsed');
    const btn = inspector.querySelector('.inspector-toggle');
    btn.textContent = collapsed ? '‹' : '›';
    btn.setAttribute('aria-label', collapsed ? 'Expand inspector' : 'Collapse inspector');
    return collapsed;
  };

  inspector.querySelector('.inspector-toggle').addEventListener('click', toggle);

  const onKey = (e) => {
    if (e.key !== '\\' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) return;
    e.preventDefault();
    toggle();
  };
  document.addEventListener('keydown', onKey);

  return () => document.removeEventListener('keydown', onKey);
}
