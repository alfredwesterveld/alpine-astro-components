export interface AlpineOpts {
  /** Attribute marking subtrees that survive ClientRouter swaps. Default 'data-astro-transition-persist'. */
  persistAttribute?: string;
}

interface AlpineLike {
  initTree: (el: Element) => void;
  destroyTree: (el: Element) => void;
  mutateDom: (cb: () => void) => void;
}

type W = Window & typeof globalThis & { Alpine?: AlpineLike };

/**
 * Wires Alpine destroyTree (before swap) + initTree (after swap) so component
 * lifecycle hooks fire correctly across Astro ClientRouter navigations. Without
 * this, window event listeners (@scroll.window, @keydown.escape.window) leak,
 * RAF loops ghost on detached DOM, and reactive effects keep dead refs alive.
 *
 * Skips subtrees marked with the persist attribute (default
 * `data-astro-transition-persist`) so persisted state survives swaps.
 */
export function installAlpineLifecycle(opts: AlpineOpts = {}): () => void {
  const persistAttr = opts.persistAttribute ?? 'data-astro-transition-persist';
  const persistSel = `[${persistAttr}]`;

  // Warn at most once per "missing-Alpine" episode. Reset when Alpine reappears
  // so a future disappearance can warn again.
  let warnedMissing = false;

  const warnAlpineMissing = (phase: 'before-swap' | 'after-swap'): void => {
    if (warnedMissing) return;
    warnedMissing = true;
    console.warn(`[astro-spa-restore] Alpine missing on astro:${phase}`);
  };

  const onBeforeSwap = () => {
    const Alpine = (window as W).Alpine;
    if (!Alpine) {
      warnAlpineMissing('before-swap');
      return;
    }
    warnedMissing = false;
    Alpine.mutateDom(() => {
      // Post-order walk: recurse into each non-persisted child first, then
      // destroy that child (so its own Alpine state + @.window listeners are
      // released even when it contains a persisted descendant). Persisted
      // nodes themselves are skipped entirely (no recurse, no destroy).
      const walk = (root: Element): void => {
        // Snapshot children to a static array — destroyTree mutates the DOM
        // and a live HTMLCollection would cause sibling skips during iteration.
        for (const child of [...root.children]) {
          if (child.hasAttribute(persistAttr)) continue;
          if (child.querySelector(persistSel)) {
            // Has persisted descendants — recurse to skip them, then destroy
            // this ancestor so its own Alpine state is released.
            walk(child);
          }
          Alpine.destroyTree(child);
        }
      };
      walk(document.body);
    });
  };

  const onAfterSwap = () => {
    const Alpine = (window as W).Alpine;
    if (!Alpine) {
      warnAlpineMissing('after-swap');
      return;
    }
    warnedMissing = false;
    Alpine.initTree(document.body);
  };

  document.addEventListener('astro:before-swap', onBeforeSwap);
  document.addEventListener('astro:after-swap', onAfterSwap);

  return () => {
    document.removeEventListener('astro:before-swap', onBeforeSwap);
    document.removeEventListener('astro:after-swap', onAfterSwap);
  };
}
