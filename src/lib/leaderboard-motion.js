import { play } from './sound.js';

// SAR1's 400ms vertical riffle, followed by a staggered settle on the new rows.
// The latest click wins; leaving the screen cancels pending navigation.
export function shuffleThen(root) {
  let pending = null, timer = null, disposed = false;
  const animations = [];
  const clear = () => { clearTimeout(timer); timer = null; animations.splice(0).forEach(a => a.cancel()); };
  return {
    run(next) {
      if (disposed) return;
      pending = next;
      if (timer !== null) return;
      play('shuffle');
      const rows = [...root.querySelectorAll('.lb-row')];
      if (!root.isConnected || !rows[0]?.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        pending = null; next(); return;
      }
      root.setAttribute('aria-busy', 'true');
      for (const [i, row] of rows.entries()) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > globalThis.innerHeight) continue;
        const shift = (i % 2 ? -1 : 1) * (18 + (i % 5) * 8);
        animations.push(row.animate([
          { transform: 'translateY(0)', opacity: 1 },
          { transform: `translateY(${shift}px)`, opacity: 0.6, offset: 0.4 },
          { transform: `translateY(${-shift / 2}px)`, opacity: 0.6, offset: 0.75 },
          { transform: 'translateY(0)', opacity: 0.85 },
        ], { duration: 400, easing: 'ease-in-out' }));
      }
      timer = setTimeout(() => {
        const done = pending; pending = null; clear(); root.removeAttribute('aria-busy');
        if (!disposed && root.isConnected) done?.();
      }, 400);
    },
    dispose() { disposed = true; pending = null; clear(); root.removeAttribute('aria-busy'); },
  };
}
