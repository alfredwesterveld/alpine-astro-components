import { flushAndFix, contentHeight } from './cv-scroll-restore';
import { log } from './log';

export interface CvOpts {
  /** CSS class on sections that use content-visibility:auto. Default 'cv-auto'. */
  cvClass?: string;
  /** CSS class toggled to force content-visibility:visible during flush. Default 'cv-auto-restore-flush'. */
  flushClass?: string;
  /** Debounce before scrollend captures cv heights into the cache. Default 200ms. */
  scrollendDebounceMs?: number;
  /**
   * Window during which scrollend cache writes are blocked after restore. Default 200ms.
   * NOTE: a timeout is a stop-gap — the real fix is signal-binding the release to the
   * end of the restore rAF chain so legitimate post-restore scrolls aren't dropped.
   */
  restoringWindowMs?: number;
  /** Window during which off-screen overflow-anchor is suppressed after restore. Default 1500ms. */
  anchorResetMs?: number;
}

type CvCacheEntry = { fingerprint: string; heights: number[] };
// Snapshot of consumer-controlled inline styles per cv element, captured BEFORE
// the first mutation we make. Hoisted to module scope so snapStyles /
// restoreStyles share a single canonical shape.
type StyleSnap = { height: string; intrinsic: string; anchor: string };
// Astro's history.state shape for scroll-restore. Astro internal (not public
// API) — warn once at runtime if the shape ever changes.
type HS = { scrollY?: number; scrollX?: number };

/**
 * Wires window listeners that restore scroll position across Astro ClientRouter
 * navigations on pages that use `content-visibility: auto`. Returns a dispose fn
 * that detaches all listeners.
 */
export function installCvScrollRestore(opts: CvOpts = {}): () => void {
  const cvClass = opts.cvClass ?? 'cv-auto';
  const flushClass = opts.flushClass ?? 'cv-auto-restore-flush';
  const scrollendDebounceMs = opts.scrollendDebounceMs ?? 200;
  const restoringWindowMs = opts.restoringWindowMs ?? 200;
  const anchorResetMs = opts.anchorResetMs ?? 1500;
  const cvSelector = `.${cvClass}`;

  // cv-auto scroll-restore: re-issue scrollTo after DOM swap resets contain-intrinsic-size.
  // Astro's ClientRouter swaps <body> via replaceWith → new DOM nodes lose remembered heights
  // → page shrinks → router's scrollTo(savedY) gets clamped. We override in astro:after-swap
  // (same microtask as router's scrollTo → no visible flash).
  let cvRestoreCtrl = new AbortController();
  // Top-level controller fires on dispose() — cancels every tracked setTimeout so
  // late timer callbacks can never mutate state after the integration is torn down.
  // Lazily allocated on first use (first before-swap or first scheduled timeout)
  // so MPA pages that never see a swap pay zero allocation cost beyond the
  // listeners themselves.
  let disposeCtrl: AbortController | undefined;
  const ensureDisposeCtrl = (): AbortController => {
    if (!disposeCtrl) disposeCtrl = new AbortController();
    return disposeCtrl;
  };
  // Snapshot of consumer-controlled inline styles per cv element, captured BEFORE
  // the first mutation we make. The package contract: never destructively clobber
  // consumer values. After the restore window ends we put these originals back.
  // (Type StyleSnap hoisted to module scope.)
  const cvStyleSnaps = new WeakMap<HTMLElement, StyleSnap>();
  const snapStyles = (els: HTMLElement[]) => {
    for (const el of els) {
      if (cvStyleSnaps.has(el)) continue;
      cvStyleSnaps.set(el, {
        height: el.style.height,
        intrinsic: el.style.getPropertyValue('contain-intrinsic-size'),
        anchor: el.style.overflowAnchor,
      });
    }
  };
  const restoreStyles = (els: HTMLElement[], which: ReadonlyArray<keyof StyleSnap>) => {
    for (const el of els) {
      const snap = cvStyleSnaps.get(el);
      if (!snap) continue;
      if (which.includes('height')) el.style.height = snap.height;
      if (which.includes('intrinsic')) {
        if (snap.intrinsic) el.style.setProperty('contain-intrinsic-size', snap.intrinsic);
        else el.style.removeProperty('contain-intrinsic-size');
      }
      if (which.includes('anchor')) el.style.overflowAnchor = snap.anchor;
    }
  };
  const cvHeightsCache = new Map<string, CvCacheEntry>();
  let cvRestoring = false;
  let scrollendTimer: ReturnType<typeof setTimeout> | null = null;

  // setTimeout that auto-cancels when any of the supplied AbortSignals fires.
  // Used to track the cvRestoring-reset and overflow-anchor-reset timers so rapid
  // back/forward nav cannot let a stale earlier timer clobber a later restore, and
  // dispose() guarantees no late callback ever runs.
  const setTimeoutAbortable = (
    fn: () => void,
    ms: number,
    ...signals: AbortSignal[]
  ): ReturnType<typeof setTimeout> => {
    const id = setTimeout(() => {
      for (const s of signals) s.removeEventListener('abort', onAbort);
      fn();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      for (const s of signals) s.removeEventListener('abort', onAbort);
    };
    for (const s of signals) {
      if (s.aborted) { clearTimeout(id); return id; }
      s.addEventListener('abort', onAbort, { once: true });
    }
    return id;
  };
  // history.state.scrollY is an Astro internal (not public API). Warn once if Astro
  // ever changes the shape — without this the package silently degrades to scroll-0.
  let warnedMissingScrollY = false;
  // LRU cap to prevent unbounded growth across long sessions.
  const CV_CACHE_MAX = 32;
  // Key by pathname+search (hash excluded — anchor-only nav doesn't change layout):
  // /a?x=1 and /a?x=2 are distinct pages with distinct heights.
  const cvCacheKey = () => location.pathname + location.search;
  const cvCacheSet = (key: string, entry: CvCacheEntry) => {
    // Re-insert to bump LRU position.
    if (cvHeightsCache.has(key)) cvHeightsCache.delete(key);
    cvHeightsCache.set(key, entry);
    while (cvHeightsCache.size > CV_CACHE_MAX) {
      const oldest = cvHeightsCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cvHeightsCache.delete(oldest);
    }
  };

  // Per-element fingerprint: prefer an explicit data-cv-key (consumer convention),
  // then id / aria-labelledby, then tag + first 32 chars of the first h1/h2/h3
  // textContent. The heading slice catches the common case of unkeyed <section>
  // elements being reordered or content-swapped — without it, three sibling
  // <section> tags fingerprint identically and a height-array shift maps the
  // wrong heights onto the wrong sections.
  const cvElKey = (el: HTMLElement): string => {
    const explicit = el.dataset.cvKey || el.id || el.getAttribute('aria-labelledby');
    if (explicit) return explicit;
    const h = el.querySelector('h1,h2,h3');
    const text = h?.textContent?.trim().slice(0, 32) ?? '';
    return text ? `${el.tagName}:${text}` : el.tagName;
  };
  const fingerprintCv = (els: HTMLElement[]) =>
    els.map(el => cvElKey(el).replace(/\|/g, '\\|')).join('|');

  // Save cv-auto heights whenever scroll settles, keyed by pathname.
  // Captures exact layout heights at the position the user leaves from,
  // so after-swap can bake them back and scrollTo lands on the right element.
  const onScrollend = () => {
    try {
      if (cvRestoring) return;
      const key = cvCacheKey();
      if (scrollendTimer) clearTimeout(scrollendTimer);
      // Defer so cv:auto can re-evaluate and collapse off-screen sections.
      // scrollend fires before cv:auto's intersection re-check runs — sections recently
      // scrolled past still show rendered heights. After settle they match the layout
      // that produced the saved scrollY.
      scrollendTimer = setTimeout(() => {
        try {
          scrollendTimer = null;
          if (cvRestoring) return;
          if (cvCacheKey() !== key) return;
          const cvEls = [...document.querySelectorAll<HTMLElement>(cvSelector)];
          if (cvEls.length === 0) return;
          cvCacheSet(key, {
            fingerprint: fingerprintCv(cvEls),
            heights: cvEls.map(el => Math.round(el.getBoundingClientRect().height)),
          });
        } catch (err) {
          log('error', 'scrollend-handler-throw', err);
        }
      }, scrollendDebounceMs);
    } catch (err) {
      log('error', 'scrollend-handler-throw', err);
    }
  };

  const onBeforeSwap = () => {
    try {
      ensureDisposeCtrl();
      cvRestoreCtrl.abort();
      cvRestoreCtrl = new AbortController();
      if (scrollendTimer) { clearTimeout(scrollendTimer); scrollendTimer = null; }
    } catch (err) {
      // Re-emit, don't swallow: throws here would otherwise surface as
      // uncaught exceptions and break e2e runners that fail on any unhandled error.
      log('error', 'before-swap-handler-throw', err);
    }
  };

  // Attempt 0: bake heights saved by the scrollend listener (captured when scroll
  // settled at this position — exact layout at save time). Reproduces the layout so
  // scrollTo(targetY) lands on the correct element. flushAndFix is NOT used here:
  // it toggles content-visibility:visible which drops cv:auto's implicit containment
  // → sections measure ~128px shorter → scroll-anchor drift displaces mid-page targets.
  // Returns true if the restore landed within this attempt (caller can return early).
  const attemptCachedHeights = (
    cvEls: HTMLElement[],
    savedCvHeights: number[] | null,
    hasCachedHeights: boolean,
    targetY: number,
    sx: number,
    sig: AbortSignal,
    raf: (fn: FrameRequestCallback) => void,
  ): boolean => {
    if (hasCachedHeights && savedCvHeights) {
      // Snapshot consumer-controlled inline values BEFORE the first mutation so we
      // can restore them later instead of clobbering with empty strings.
      snapStyles(cvEls);
      // Explicit `height` bypasses cv:auto's contain-intrinsic-size resolution timing:
      // setting contain-intrinsic-size alone doesn't update scrollHeight synchronously
      // (intersection observer hasn't re-classified sections yet at after-swap time).
      cvEls.forEach((el, i) => {
        if (savedCvHeights[i] > 0) el.style.height = `${savedCvHeights[i]}px`;
      });
    }

    const maxY0 = document.documentElement.scrollHeight - innerHeight;
    if (targetY > maxY0) return false;

    window.scrollTo(sx, targetY);
    // Defer the explicit-height → intrinsic-size switch until after Alpine.initTree and
    // any other after-swap listeners have run. Switching synchronously causes a transient
    // scrollH drop: on-screen sections measure real content immediately, while off-screen
    // sections lag re-classification under cv:auto. That drop above the viewport, with
    // overflow-anchor still default, makes the browser shift scrollY to keep the visual
    // anchor stable — overshooting the restore. Wait one rAF, lock anchors first, then
    // switch and re-pin atomically.
    raf(() => {
      if (sig.aborted) return;
      // Snapshot before first overflowAnchor mutation (covers the hasCachedHeights=false
      // path where we never snapshot earlier).
      snapStyles(cvEls);
      cvEls.forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= innerHeight) el.style.overflowAnchor = 'none';
      });
      if (hasCachedHeights && savedCvHeights) {
        cvEls.forEach((el, i) => {
          // Restore consumer height instead of clearing — the explicit-height
          // bridge has done its job; intrinsic-size takes over below.
          const snap = cvStyleSnaps.get(el);
          el.style.height = snap ? snap.height : '';
          el.style.removeProperty('contain-intrinsic-size');
          if (savedCvHeights[i] > 0) {
            const c = contentHeight(el, savedCvHeights[i]);
            if (c > 0) el.style.setProperty('contain-intrinsic-size', `auto ${c}px`);
          }
        });
      }
      window.scrollTo(sx, targetY);
      setTimeoutAbortable(() => {
        // Restore consumer overflowAnchor instead of clearing.
        restoreStyles(cvEls, ['anchor']);
      }, anchorResetMs, sig, ensureDisposeCtrl().signal);
    });
    return true;
  };

  // Attempt 1: synchronous flush in the after-swap microtask (same task as the
  // router's scrollTo). Returns true if the page is now tall enough and we have
  // re-issued scrollTo to the saved position.
  const attemptSyncFlush = (
    cvEls: HTMLElement[],
    targetY: number,
    sx: number,
    sig: AbortSignal,
  ): boolean => {
    const maxY1 = flushAndFix(cvEls, undefined, flushClass);
    if (sig.aborted || targetY > maxY1) return false;
    window.scrollTo(sx, targetY);
    return true;
  };

  // Attempt 2: double-rAF retry — gives the browser an additional layout cycle
  // for cv:auto sections that didn't unskip in time for attempt 1.
  // Schedules attempt 3 internally if it still fails.
  const attemptDoubleRafFlush = (
    targetY: number,
    sx: number,
    sig: AbortSignal,
    raf: (fn: FrameRequestCallback) => void,
  ): void => {
    raf(() => raf(() => {
      if (sig.aborted) return;
      const fresh = [...document.querySelectorAll<HTMLElement>(cvSelector)];
      const maxY2 = flushAndFix(fresh, undefined, flushClass);
      if (targetY <= maxY2) {
        window.scrollTo(sx, targetY);
        return;
      }
      attemptVisibilityRetry(fresh, targetY, sx, sig);
    }));
  };

  // Attempt 3 (Chrome 125+): contentvisibilityautostatechange fires when a
  // cv:auto section unskips; re-issue scrollTo if the page finally grew past
  // targetY. No-op on browsers that don't support the event.
  const attemptVisibilityRetry = (
    fresh: HTMLElement[],
    targetY: number,
    sx: number,
    sig: AbortSignal,
  ): void => {
    if (!('oncontentvisibilityautostatechange' in HTMLElement.prototype)) return;
    let scrolled = false;
    const onUnskip = () => {
      if (scrolled || sig.aborted) return;
      if (targetY <= document.documentElement.scrollHeight - innerHeight) {
        scrolled = true;
        window.scrollTo(sx, targetY);
        fresh.forEach(el => el.removeEventListener('contentvisibilityautostatechange', onUnskip));
      }
    };
    // Re-check sig.aborted before each attach: an abort fired between the rAF
    // frames or partway through the loop would otherwise leave listeners bound
    // to an already-aborted signal (browsers still attach, then drop on first
    // dispatch — silent leak until DOM removal).
    for (const el of fresh) {
      if (sig.aborted) break;
      el.addEventListener('contentvisibilityautostatechange', onUnskip, { signal: sig });
    }
  };

  const onAfterSwap = () => {
    try {
    const state = history.state as HS | null;
    if (!warnedMissingScrollY && (state == null || !('scrollY' in state))) {
      warnedMissingScrollY = true;
      log(
        'warn',
        'history.state.scrollY missing — Astro may have changed its scroll-state shape. Scroll restoration will fall back to top of page.',
      );
    }
    const targetY = state?.scrollY ?? 0;

    const sig = cvRestoreCtrl.signal;
    const sx = state?.scrollX ?? 0;
    const cachedEntry = cvHeightsCache.get(cvCacheKey()) ?? null;
    const cvEls = [...document.querySelectorAll<HTMLElement>(cvSelector)];

    // In a backgrounded tab, requestAnimationFrame is throttled to seconds-long
    // intervals (or paused entirely). Fall back to setTimeout(0) so the restore
    // chain still runs promptly and the user doesn't see a late visible scroll
    // jump when they refocus the tab.
    const raf: (fn: FrameRequestCallback) => void =
      document.visibilityState === 'hidden'
        ? (fn) => { setTimeout(() => fn(performance.now()), 0); }
        : requestAnimationFrame;

    // Reject cache if length OR fingerprint differs — protects against reordered sections
    // silently mapping wrong heights onto wrong elements.
    const hasCachedHeights =
      cachedEntry !== null &&
      cvEls.length === cachedEntry.heights.length &&
      fingerprintCv(cvEls) === cachedEntry.fingerprint;
    const savedCvHeights = hasCachedHeights ? cachedEntry!.heights : null;

    // targetY===0 (top of page, or history.state may legitimately be null on first
    // SPA nav): no scrollTo needed, but still bake cached intrinsic-sizes so that
    // any subsequent programmatic scroll (anchor click, focus, etc.) lands correctly.
    // Skip the restoring flag + rAF re-pin chain since there's no overshoot risk.
    if (targetY === 0) {
      if (hasCachedHeights && savedCvHeights) {
        snapStyles(cvEls);
        cvEls.forEach((el, i) => {
          if (savedCvHeights[i] > 0) {
            const c = contentHeight(el, savedCvHeights[i]);
            if (c > 0) el.style.setProperty('contain-intrinsic-size', `auto ${c}px`);
          }
        });
      }
      return;
    }

    // Block scrollend from overwriting the cache during back-nav settle.
    // Auto-cancel on next swap (sig) or dispose so rapid nav can't have an earlier
    // timer flip cvRestoring=false mid second restore → cache pollution. The same
    // window also bounds when we restore consumer-controlled inline values that we
    // overwrote during the bake.
    cvRestoring = true;
    setTimeoutAbortable(() => {
      cvRestoring = false;
      // If consumer had an explicit contain-intrinsic-size, theirs wins now that
      // the load-bearing bake has done its job. (Empty consumer value → leave our
      // bake in place; cv:auto's intersection observer has classified by now.)
      for (const el of cvEls) {
        const snap = cvStyleSnaps.get(el);
        if (snap?.intrinsic) el.style.setProperty('contain-intrinsic-size', snap.intrinsic);
      }
    }, restoringWindowMs, sig, ensureDisposeCtrl().signal);

    // Attempt 0: bake cached heights and try to land via the scrollend-captured
    // layout. Returns true if we landed (and scheduled the deferred restore).
    if (attemptCachedHeights(cvEls, savedCvHeights, hasCachedHeights, targetY, sx, sig, raf)) {
      return;
    }

    // Page too short → fall through to flush-and-bake. Covers deep-scroll where saved
    // heights ARE the large values and the page genuinely needs expanding.
    if (hasCachedHeights) {
      // Restore consumer height instead of clearing (we set it in the bake above).
      restoreStyles(cvEls, ['height']);
    }
    if (cvEls.length === 0) return;

    // Snapshot before attempt-1 so flushAndFix can be reverted by the restoration
    // timer even on the cache-miss path.
    snapStyles(cvEls);

    // Attempt 1: synchronous flush in after-swap microtask.
    if (attemptSyncFlush(cvEls, targetY, sx, sig)) return;

    // Attempt 2 + 3: double-rAF retry, then contentvisibilityautostatechange wait.
    attemptDoubleRafFlush(targetY, sx, sig, raf);
    } catch (err) {
      // Re-emit, don't swallow: a throw here (poisoned history.state, broken
      // querySelectorAll, consumer styles that crash getComputedStyle) would
      // otherwise break the swap and surface as an uncaught exception.
      log('error', 'after-swap-handler-throw', err);
    }
  };

  // scrollend on window (not document): Safari historically inconsistent about bubbling
  // scrollend through the document, and {passive:true} avoids the default-passive ambiguity.
  // Fallback to 'scroll' + debounce for browsers that don't support scrollend (Safari < 18).
  const scrollSupported = 'onscrollend' in window;
  const scrollEvent = scrollSupported ? 'scrollend' : 'scroll';
  const scrollHandler = scrollSupported
    ? onScrollend
    : () => {
        if (scrollendTimer) clearTimeout(scrollendTimer);
        scrollendTimer = setTimeout(() => {
          scrollendTimer = null;
          onScrollend();
        }, scrollendDebounceMs);
      };
  window.addEventListener(scrollEvent, scrollHandler, { passive: true });
  document.addEventListener('astro:before-swap', onBeforeSwap);
  document.addEventListener('astro:after-swap', onAfterSwap);

  return () => {
    window.removeEventListener(scrollEvent, scrollHandler);
    document.removeEventListener('astro:before-swap', onBeforeSwap);
    document.removeEventListener('astro:after-swap', onAfterSwap);
    cvRestoreCtrl.abort();
    // Aborts every tracked setTimeoutAbortable callback (cvRestoring reset + anchor
    // reset). Without this, late timers can mutate state after the integration is
    // disposed. May be undefined if dispose() is called before any swap was
    // observed (MPA page or unused integration) — nothing to abort in that case.
    disposeCtrl?.abort();
    if (scrollendTimer) clearTimeout(scrollendTimer);
  };
}
