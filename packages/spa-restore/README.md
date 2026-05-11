# @alfredwesterveld/astro-spa-restore

Astro integration that fixes two correctness bugs in `<ClientRouter />` view-transition swaps:

1. **cv-auto scroll-restore** — when pages use `content-visibility: auto`, ClientRouter's `scrollTo(savedY)` gets browser-clamped because cv-auto sections collapse to placeholder height after `<body>` is replaced. This integration captures heights at scrollend, then bakes them back via `contain-intrinsic-size` after swap so scroll-restore lands on the right element.
2. **Alpine destroyTree/initTree lifecycle** — `@astrojs/alpinejs` only calls `Alpine.start()` once. Without manual `destroyTree` (before swap) + `initTree` (after swap), window listeners leak, RAFs ghost on detached DOM, and reactive effects keep dead refs alive.

## Install

```bash
bun add @alfredwesterveld/astro-spa-restore
```

## Use

```ts
// astro.config.mjs
import { defineConfig } from 'astro/config';
import spaRestore from '@alfredwesterveld/astro-spa-restore';

export default defineConfig({
  integrations: [
    spaRestore({
      alpine: true,        // wire Alpine destroyTree/initTree (default false)
      injectStyles: true,  // auto-inject .cv-auto utility CSS (default true)
    }),
  ],
});
```

Mark sections that should use content-visibility:auto:

```html
<section class="cv-auto"> ... </section>
```

## Options

| Option | Default | What |
|---|---|---|
| `cvClass` | `'cv-auto'` | CSS class on sections that opt into content-visibility:auto |
| `flushClass` | `'cv-auto-restore-flush'` | Class toggled to force visible during measurement |
| `scrollendDebounceMs` | `200` | Debounce before scrollend captures cv heights |
| `restoringWindowMs` | `500` | Window during which scrollend cache writes are blocked after restore |
| `anchorResetMs` | `1500` | Window during which off-screen overflow-anchor is suppressed after restore |
| `alpine` | `false` | Wire Alpine destroyTree (before-swap) + initTree (after-swap) |
| `persistAttribute` | `'data-astro-transition-persist'` | Attribute marking subtrees that survive swaps |
| `injectStyles` | `true` | Auto-inject the `.cv-auto` utility CSS |

## Manual install (non-Astro consumers)

```ts
import { installCvScrollRestore } from '@alfredwesterveld/astro-spa-restore/runtime/cv';
import { installAlpineLifecycle } from '@alfredwesterveld/astro-spa-restore/runtime/alpine';
import '@alfredwesterveld/astro-spa-restore/styles/cv-auto.css';

installCvScrollRestore({});
installAlpineLifecycle({});
```

Both installers return a dispose function that detaches listeners.
