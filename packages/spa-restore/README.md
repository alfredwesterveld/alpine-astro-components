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

### Avoiding duplicate CSS

`injectStyles` defaults to `true`, which auto-injects `cv-auto.css` via the integration. If you also import the stylesheet manually (e.g. `import '@alfredwesterveld/astro-spa-restore/styles/cv-auto.css'` in a layout, or pull it into a global stylesheet), set `injectStyles: false` on the integration to avoid emitting the same rules twice.

## ClientRouter detection

The injected runtime is inert on pages that don't use `<ClientRouter />`. It always attaches its window listeners, but a capture-phase guard suppresses `astro:after-swap` handlers until at least one real `astro:before-swap` event has fired (which only happens during a ClientRouter view-transition swap). If no swap is observed within 5 s of page load, the guard stays active for the rest of the page lifetime — so static MPA pages pay only the initial listener install cost.

## Validation

`cvClass`, `flushClass`, and `persistAttribute` are interpolated into CSS selectors and JS source at runtime. The integration validates them at `astro:config:setup`:

- `cvClass` / `flushClass`: `/^[A-Za-z_-][\w-]*$/`
- `persistAttribute`: `/^[a-z][a-z0-9-]*$/`

Invalid values throw at build/dev startup with a clear error.

When `alpine: true`, the integration also verifies that `alpinejs` is resolvable from your project root and throws at startup if it isn't, instead of warning silently at runtime.

## Requirements & caveats

### ClientRouter requirement

This package is intended for sites that use Astro's `<ClientRouter />`. On pure MPA pages (no view transitions) it stays inert: the injected script attaches its window listeners but a capture-phase guard suppresses `astro:after-swap` handlers until at least one real `astro:before-swap` event fires (which only happens during a ClientRouter view-transition swap). If no swap is observed within 5 s of page load, the guard stays active for the rest of the page lifetime — so MPA pages pay only the initial listener install cost.

### Alpine load order

When `alpine: true`, **Alpine must be available on `window` before `astro:after-swap` fires**. `@astrojs/alpinejs` v0.4 only triggers `Alpine.start()` on the initial `DOMContentLoaded`; it does not re-fire after a ClientRouter swap. The `Alpine.initTree()` calls this package issues after each swap therefore require Alpine to already be present on `window`. If Alpine isn't loaded yet, the package warns once per missing-Alpine episode and skips the call (re-arming when Alpine reappears).

### Browser support

The `scrollend` event used to capture cv-auto heights at scroll-settle requires Chrome 114+ / Safari TP / Firefox 109+. On older browsers `scrollend` never fires, so the cv-auto height cache is only populated on-demand during restore — the package still degrades gracefully (scroll-restore behaves like ClientRouter's default), it just doesn't pre-cache layouts for back/forward nav.

### `.cv-auto` CSS layer caveat

The auto-injected `cv-auto.css` declares its rules inside `@layer utilities`. Consumers using strict `@layer` ordering should import this package's stylesheet (or rely on `injectStyles: true`) **before** their own `utilities` layer is declared, otherwise the consumer's later `utilities` layer may shadow `.cv-auto` rules.

### `data-cv-key` convention

Authors can put `data-cv-key="..."` on any `.cv-auto` section to use a stable cache key that's immune to heading-text edits, A/B copy variants, or section reorders. The default fingerprint falls back to `id`, then `aria-labelledby`, then `tag + first 32 chars of the first h1/h2/h3`, which is robust enough for most pages — but for hero sections, repeated card patterns, or anything where copy churns frequently, an explicit `data-cv-key` is strongly recommended.
