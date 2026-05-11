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

  const onBeforeSwap = () => {
    const Alpine = (window as W).Alpine;
    if (!Alpine) return;
    Alpine.mutateDom(() => {
      (function destroyNonPersisted(root: Element) {
        for (const child of root.children) {
          if (child.hasAttribute(persistAttr)) continue;
          if (child.querySelector(persistSel)) {
            // Has persisted descendants — recurse instead of destroying full subtree
            destroyNonPersisted(child);
          } else {
            Alpine.destroyTree(child as Element);
          }
        }
      })(document.body);
    });
  };

  const onAfterSwap = () => {
    const Alpine = (window as W).Alpine;
    if (!Alpine) {
      console.warn('[astro-spa-restore] Alpine missing on astro:after-swap');
      return;
    }
    Alpine.initTree(document.body);
  };

  document.addEventListener('astro:before-swap', onBeforeSwap);
  document.addEventListener('astro:after-swap', onAfterSwap);

  return () => {
    document.removeEventListener('astro:before-swap', onBeforeSwap);
    document.removeEventListener('astro:after-swap', onAfterSwap);
  };
}
