# @alfredwesterveld/astro-spa-restore

Astro integration that fixes two correctness bugs in `<ClientRouter />` view-transition swaps:

1. **cv-auto scroll-restore** — when pages use `content-visibility: auto`, ClientRouter's `scrollTo(savedY)` gets browser-clamped because cv-auto sections collapse to placeholder height after `<body>` is replaced. This integration captures heights at scrollend, then bakes them back via `contain-intrinsic-size` after swap so scroll-restore lands on the right element.
2. **Alpine destroyTree/initTree lifecycle** — `@astrojs/alpinejs` only calls `Alpine.start()` once. Without manual `destroyTree` (before swap) + `initTree` (after swap), window listeners leak, RAFs ghost on detached DOM, and reactive effects keep dead refs alive.

`transition:persist` Alpine state (e.g. lightboxes, video players) is preserved across swaps via a detach/destroy/reattach pattern — see [Persisted nodes](#persisted-nodes-transitionpersist).

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

Mark sections that should use `content-visibility: auto`:

```html
<section class="cv-auto"> ... </section>

<!-- For sections whose copy churns (heroes, A/B tests, repeated cards), give a
     stable cache key so the height fingerprint survives copy edits: -->
<section class="cv-auto" data-cv-key="hero-home"> ... </section>
```

## Options

| Option | Default | What |
|---|---|---|
| `cvClass` | `'cv-auto'` | CSS class on sections that opt into `content-visibility: auto` |
| `flushClass` | `'cv-auto-restore-flush'` | Class toggled to force visible during measurement |
| `scrollendDebounceMs` | `200` | Debounce before `scrollend` captures cv heights |
| `restoringWindowMs` | `200` | Window during which `scrollend` cache writes are blocked after restore. Tightened from 500ms in 0.1.0 — see [Tuning](#tuning) if you observe drift after restore |
| `anchorResetMs` | `1500` | Window during which off-screen `overflow-anchor` is suppressed after restore |
| `alpine` | `false` | Wire Alpine `destroyTree` (before-swap) + `initTree` (after-swap) |
| `persistAttribute` | `'data-astro-transition-persist'` | Attribute marking subtrees that survive swaps |
| `injectStyles` | `true` | Auto-inject the `.cv-auto` utility CSS |

## Manual install (non-Astro consumers)

```ts
import { installCvScrollRestore } from '@alfredwesterveld/astro-spa-restore/runtime/cv';
import { installAlpineLifecycle } from '@alfredwesterveld/astro-spa-restore/runtime/alpine';
import '@alfredwesterveld/astro-spa-restore/styles/cv-auto.css';

const disposeCv = installCvScrollRestore({});
const disposeAlpine = installAlpineLifecycle({});

// Later — for example in a teardown hook of an HMR boundary:
disposeCv();
disposeAlpine();
```

Both installers return a dispose function that:

- Removes every listener registered on `document` / `window`.
- Aborts an internal `AbortController` that cancels every pending `setTimeout` (restore-window release, anchor reset, scrollend debounce). No timer can fire after dispose.
- Is safe to call multiple times (idempotent).

## How it works

On every `astro:after-swap`, the package runs a four-step fallback cascade against the new DOM. Each step short-circuits the moment the page reaches the saved scroll position. The chain exists because cv-auto sections re-classify on a delay that varies by frame budget, viewport intersection, and visibility state.

| Step | Name | When it wins | Notes |
|---|---|---|---|
| 0 | `attemptCachedHeights` | Cache hit for current `pathname+search` and the fingerprint matches | Bakes saved per-section heights into `contain-intrinsic-size` immediately, then **defers the explicit-height → intrinsic-size switch behind a `requestAnimationFrame` and locks `overflow-anchor` first**. This step is load-bearing — switching synchronously caused a 333px overshoot in earlier versions because on-screen sections re-classified faster than off-screen sections, dropping `scrollHeight` below the target Y mid-restore. |
| 1 | `attemptSyncFlush` | Page is short enough that flushing every cv-auto section to visible reaches `scrollHeight ≥ targetY` in the same frame | One forced layout, no rAF. |
| 2 | `attemptDoubleRafFlush` | Page is tall and needs the browser to re-classify cv-auto sections after the swap | `rAF → queueMicrotask → flush + scrollTo`. **Tightened from `rAF → rAF` in 0.1.0** — if you see post-swap drift on slow devices, see [Tuning](#tuning). |
| 3 | `attemptVisibilityRetry` | Tab is hidden at swap time (e.g. user nav'd while tab in background) | Falls back to `setTimeout(0)` since `requestAnimationFrame` is throttled or paused for hidden tabs. |

The cv heights cache survives only within a session: a `Map<key, { fingerprint, heights[] }>` keyed by `pathname + search`, capped at **32 entries (LRU eviction)**. Cross-reload survival via `sessionStorage` is not implemented.

### Cache key + fingerprint

Cache **key**: `${location.pathname}${location.search}` — distinguishes `/blog` from `/blog?page=2` so back-nav between query variants doesn't restore the wrong heights.

Cache **fingerprint** (per-entry, validates the entry still applies to the new DOM):

1. `data-cv-key="..."` if present (recommended for hero/repeated-card patterns).
2. Else `id` if set.
3. Else `aria-labelledby` text if resolvable.
4. Else `tagName + first 32 chars of the first h1/h2/h3 textContent` inside the section.

If the fingerprint **or** the section count differs between cache and live DOM, the entry is discarded and the cascade falls through to step 1.

## Persisted nodes (transition:persist)

Alpine's `destroyTree` walks descendants via the default walker and is **persist-blind** — calling `destroyTree(ancestor)` would tear down `_x_effects` / `_x_attributeCleanups` on any persisted descendant, breaking `transition:persist` state (lightbox open/closed, video timestamp, marquee RAF, etc.).

This package handles it as follows on `astro:before-swap`:

1. Find every `[${persistAttribute}]` element under `<body>`.
2. Replace each with a `<!-- astro-spa-restore:persist -->` comment placeholder.
3. Run `Alpine.destroyTree` on every top-level body child — now safe, because persisted subtrees are unreachable.
4. Re-insert each persisted node at its original position (parent + nextSibling).

Astro's view transition then moves the persisted nodes from the old body into the new body unchanged.

## Consumer inline-style preservation

`installCvScrollRestore` only mutates three inline styles per cv-auto section: `height`, `contain-intrinsic-size`, `overflow-anchor`. **Any consumer-set value for those three styles is snapshotted before the first mutation and restored when `restoringWindowMs` expires.** All other inline styles are left untouched.

## Tuning

Defaults are calibrated for `bun scripts/repro-scroll.ts` on a fast laptop (headless Chromium). Real browsers settle layout asynchronously; if you observe symptoms below, adjust:

| Symptom | Likely cause | Knob |
|---|---|---|
| Restore lands a few hundred px past target on slow / low-end devices | `attemptDoubleRafFlush` runs flush before cv-auto re-classification finishes | Open issue / vendor a build that swaps `queueMicrotask` back to a second `rAF` |
| Saved scrollY drifts between back-nav cycles, especially on pages with images that decode after first paint | Late layout shift outside `restoringWindowMs` writes a wrong scrollend save | Bump `restoringWindowMs` (try 350-500ms) |
| Restore overshoots when web fonts swap (FOUT) post-restore | Font-swap reflow happens after our anchor-lock releases | Bump `anchorResetMs` and/or use `font-display: optional` |
| Cache miss on every back-nav for a hero whose copy changes | Fingerprint defaulting to heading text, copy changed | Add `data-cv-key="hero-home"` to the hero section |

Headless ≠ real browser: an 8/8 PASS on `repro-scroll.ts` is a necessary but not sufficient regression check.

## Validation

`cvClass`, `flushClass`, and `persistAttribute` are interpolated into CSS selectors and JS source at runtime. The integration validates them at `astro:config:setup`:

- `cvClass` / `flushClass`: `/^[A-Za-z_-][\w-]*$/`
- `persistAttribute`: `/^[a-z][a-z0-9-]*$/`

Invalid values throw at build/dev startup with a clear error. The injected runtime additionally JSON-escapes the values (`<`, U+2028, U+2029) so a malicious or unusual string can't escape its string literal in the emitted page script.

When `alpine: true`, the integration also verifies that `alpinejs` is resolvable from your project root (via `createRequire(import.meta.url)`) and throws at startup if it isn't, instead of warning silently at runtime.

## Error handling

Every event handler the package registers (`scrollend`, `astro:before-swap`, `astro:after-swap`) wraps its body in `try` / `catch`. An uncaught throw inside one handler is logged via the internal `log('error', ...)` helper (prefixed `[astro-spa-restore]`) and rethrows are suppressed — the swap continues, other handlers still fire, and a single noisy section can't stall the whole navigation.

## Requirements & caveats

### ClientRouter requirement

This package is intended for sites that use Astro's `<ClientRouter />`. On pure MPA pages (no view transitions) it stays inert: the injected script attaches its window listeners but a capture-phase guard suppresses `astro:after-swap` handlers until at least one real `astro:before-swap` event fires (which only happens during a ClientRouter view-transition swap). If no swap is observed within 5 s of page load, the guard stays active for the rest of the page lifetime — so MPA pages pay only the initial listener install cost.

### Alpine load order

When `alpine: true`, **Alpine must be available on `window` before `astro:after-swap` fires**. `@astrojs/alpinejs` v0.4 only triggers `Alpine.start()` on the initial `DOMContentLoaded`; it does not re-fire after a ClientRouter swap. The `Alpine.initTree()` calls this package issues after each swap therefore require Alpine to already be present on `window`. If Alpine isn't loaded yet, the package warns once per missing-Alpine episode and skips the call (re-arming when Alpine reappears).

### Browser support

The `scrollend` event used to capture cv-auto heights at scroll-settle requires Chrome 114+ / Safari TP / Firefox 109+. On older browsers `scrollend` never fires, so the cv-auto height cache is only populated on-demand during restore — the package still degrades gracefully (scroll-restore behaves like ClientRouter's default), it just doesn't pre-cache layouts for back/forward nav.

### Astro internal: `history.state.scrollY`

The cv-auto restore path reads `history.state.scrollY` to know where the previous page was scrolled to. This shape is set by Astro's `ClientRouter` and is **not part of Astro's public API**. The package warns once via `console.warn` if the field is missing on the first observed `astro:after-swap`, so you'll know immediately if a future Astro release changes the shape.

### Avoiding duplicate CSS

`injectStyles` defaults to `true`, which auto-injects `cv-auto.css` via the integration. If you also import the stylesheet manually (e.g. `import '@alfredwesterveld/astro-spa-restore/styles/cv-auto.css'` in a layout, or pull it into a global stylesheet), set `injectStyles: false` on the integration to avoid emitting the same rules twice.

### `.cv-auto` CSS layer caveat

The auto-injected `cv-auto.css` declares its rules inside `@layer utilities`. Consumers using strict `@layer` ordering should import this package's stylesheet (or rely on `injectStyles: true`) **before** their own `utilities` layer is declared, otherwise the consumer's later `utilities` layer may shadow `.cv-auto` rules.

### `data-cv-key` convention

Authors can put `data-cv-key="..."` on any `.cv-auto` section to use a stable cache key that's immune to heading-text edits, A/B copy variants, or section reorders. The default fingerprint hierarchy described in [Cache key + fingerprint](#cache-key--fingerprint) is robust enough for most pages, but for hero sections, repeated card patterns, or anything where copy churns frequently, an explicit `data-cv-key` is strongly recommended.

## Testing

```bash
bun run --cwd packages/spa-restore test     # unit + happy-dom (72 tests)
bun run --cwd packages/spa-restore build    # tsc → dist/
```

Consumer-side regression (in a project that uses the package):

```bash
bun scripts/repro-scroll.ts
```

The repro script drives a headless Chromium through 8 scroll-restore scenarios (S1-S8: back-nav, control without cv-auto, hash links, deep scroll, stability over time, mid-page CTA back-nav). All 8 must end `delta=0px`.

## Changelog

### v0.2.0

23 review fixes landed in 6 worktrees:

- **Security:** validate + JSON-escape user-supplied class/attribute strings before injecting into the page script (`swz`).
- **Persisted nodes:** Alpine `destroyTree` no longer reaches into `transition:persist` subtrees — detach via comment placeholder, destroy ancestor, reattach (`6a9`).
- **Cache:** keyed by `pathname+search`, LRU-capped at 32 (`niw`); fingerprint strengthened with first-heading text and `data-cv-key` support (`455`); preserves consumer inline `style.height` / `contain-intrinsic-size` / `overflow-anchor` (`6el`).
- **Lifecycle:** `setTimeout` handles tracked via `AbortController`, cancelled on `dispose()` (`0mn` / `zh4`); lazy controller allocation; `targetY===0` still bakes intrinsic sizes (`7vb`); `setTimeout(0)` fallback when tab hidden (`67p`); `restoringWindowMs` default 500 → 200ms (`691`); `attemptDoubleRafFlush` switched from `rAF→rAF` to `rAF→queueMicrotask` (`agb`).
- **Robustness:** every event handler wrapped in `try / catch` with `console.error` re-emit (`od4`); abort-signal re-checked inside deep `rAF` callback (`907`); `scrollend` listener moved to `window` with `{ passive: true }` (`08e`); warn once when `history.state.scrollY` shape is missing (`67a`); symmetric Alpine-missing warn-once (`m3w`); snapshot live `HTMLCollection` to array before destroy walk (`skq`).
- **Integration:** capture-phase guard makes the runtime inert on MPA pages without `<ClientRouter />` (`tzh`); fail-fast at config-setup if `alpine: true` but `alpinejs` is unresolvable (`3ze`).
- **Tests:** +28 listener-glue tests covering cache key, abort flow, LRU eviction, persist-walk detach/reattach, integration emitted-runtime smoke (`y0p`); +4 error-boundary tests (`od4`).
- **Cleanup:** internal `log()` helper, hoisted module types, `tsc --noEmit` post-test, attempts renamed (`cvFingerprint` → `fingerprintCv`, attempt 0/1/2/3 → `attemptCachedHeights` / `attemptSyncFlush` / `attemptDoubleRafFlush` / `attemptVisibilityRetry`) (`fxg`).

Test count: **19 → 72 pass**. Consumer `repro-scroll.ts` regression: **8/8 PASS, delta=0px**.

### v0.1.0

Initial release.

## License

MIT.
