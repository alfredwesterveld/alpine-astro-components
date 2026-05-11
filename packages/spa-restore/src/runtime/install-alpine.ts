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
      // Detach persisted subtrees behind comment placeholders so that
      // Alpine.destroyTree (which deep-walks via the default walker and is
      // persist-blind) cannot reach their cleanup hooks. We then destroyTree
      // every non-persisted top-level child (releasing its own state +
      // @.window listeners), then re-insert the persisted nodes at their
      // original positions so Astro's view-transition can move them into the
      // new body.
      const persisted = [...document.body.querySelectorAll(persistSel)] as Element[];
      const slots = persisted.map((node) => {
        const ph = document.createComment('astro-spa-restore:persist');
        node.parentNode!.replaceChild(ph, node);
        return { ph, node };
      });
      for (const child of [...document.body.children]) {
        Alpine.destroyTree(child);
      }
      for (const { ph, node } of slots) {
        ph.parentNode!.replaceChild(node, ph);
      }
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
