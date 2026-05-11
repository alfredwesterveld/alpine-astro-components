import { flushAndFix, contentHeight } from './cv-scroll-restore';

export interface CvOpts {
  /** CSS class on sections that use content-visibility:auto. Default 'cv-auto'. */
  cvClass?: string;
  /** CSS class toggled to force content-visibility:visible during flush. Default 'cv-auto-restore-flush'. */
  flushClass?: string;
  /** Debounce before scrollend captures cv heights into the cache. Default 200ms. */
  scrollendDebounceMs?: number;
  /** Window during which scrollend cache writes are blocked after restore. Default 500ms. */
  restoringWindowMs?: number;
  /** Window during which off-screen overflow-anchor is suppressed after restore. Default 1500ms. */
  anchorResetMs?: number;
}

type CvCacheEntry = { fingerprint: string; heights: number[] };

/**
 * Wires window listeners that restore scroll position across Astro ClientRouter
 * navigations on pages that use `content-visibility: auto`. Returns a dispose fn
 * that detaches all listeners.
 */
export function installCvScrollRestore(opts: CvOpts = {}): () => void {
  const cvClass = opts.cvClass ?? 'cv-auto';
  const flushClass = opts.flushClass ?? 'cv-auto-restore-flush';
  const scrollendDebounceMs = opts.scrollendDebounceMs ?? 200;
  const restoringWindowMs = opts.restoringWindowMs ?? 500;
  const anchorResetMs = opts.anchorResetMs ?? 1500;
  const cvSelector = `.${cvClass}`;

  // cv-auto scroll-restore: re-issue scrollTo after DOM swap resets contain-intrinsic-size.
  // Astro's ClientRouter swaps <body> via replaceWith → new DOM nodes lose remembered heights
  // → page shrinks → router's scrollTo(savedY) gets clamped. We override in astro:after-swap
  // (same microtask as router's scrollTo → no visible flash).
  let cvRestoreCtrl = new AbortController();
  const cvHeightsCache = new Map<string, CvCacheEntry>();
  let cvRestoring = false;
  let scrollendTimer: ReturnType<typeof setTimeout> | null = null;

  const cvFingerprint = (els: HTMLElement[]) =>
    els.map(el => el.id || el.getAttribute('aria-labelledby') || el.tagName).join('|');

  // Save cv-auto heights whenever scroll settles, keyed by pathname.
  // Captures exact layout heights at the position the user leaves from,
  // so after-swap can bake them back and scrollTo lands on the right element.
  const onScrollend = () => {
    if (cvRestoring) return;
    const path = location.pathname;
    if (scrollendTimer) clearTimeout(scrollendTimer);
    // Defer so cv:auto can re-evaluate and collapse off-screen sections.
    // scrollend fires before cv:auto's intersection re-check runs — sections recently
    // scrolled past still show rendered heights. After settle they match the layout
    // that produced the saved scrollY.
    scrollendTimer = setTimeout(() => {
      scrollendTimer = null;
      if (cvRestoring) return;
      if (location.pathname !== path) return;
      const cvEls = [...document.querySelectorAll<HTMLElement>(cvSelector)];
      if (cvEls.length === 0) return;
      cvHeightsCache.set(path, {
        fingerprint: cvFingerprint(cvEls),
        heights: cvEls.map(el => Math.round(el.getBoundingClientRect().height)),
      });
    }, scrollendDebounceMs);
  };

  const onBeforeSwap = () => {
    cvRestoreCtrl.abort();
    cvRestoreCtrl = new AbortController();
    if (scrollendTimer) { clearTimeout(scrollendTimer); scrollendTimer = null; }
  };

  const onAfterSwap = () => {
    type HS = { scrollY?: number; scrollX?: number };
    const state = history.state as HS | null;
    const targetY = state?.scrollY ?? 0;
    if (targetY === 0) return;

    const sig = cvRestoreCtrl.signal;
    const sx = state?.scrollX ?? 0;
    const cachedEntry = cvHeightsCache.get(location.pathname) ?? null;
    const cvEls = [...document.querySelectorAll<HTMLElement>(cvSelector)];

    // Block scrollend from overwriting the cache during back-nav settle.
    cvRestoring = true;
    setTimeout(() => { cvRestoring = false; }, restoringWindowMs);

    // Attempt 0: bake heights saved by the scrollend listener (captured when scroll
    // settled at this position — exact layout at save time). Reproduces the layout so
    // scrollTo(targetY) lands on the correct element. flushAndFix is NOT used here:
    // it toggles content-visibility:visible which drops cv:auto's implicit containment
    // → sections measure ~128px shorter → scroll-anchor drift displaces mid-page targets.
    // Reject cache if length OR fingerprint differs — protects against reordered sections
    // silently mapping wrong heights onto wrong elements.
    const hasCachedHeights =
      cachedEntry !== null &&
      cvEls.length === cachedEntry.heights.length &&
      cvFingerprint(cvEls) === cachedEntry.fingerprint;
    const savedCvHeights = hasCachedHeights ? cachedEntry!.heights : null;
    if (hasCachedHeights && savedCvHeights) {
      // Explicit `height` bypasses cv:auto's contain-intrinsic-size resolution timing:
      // setting contain-intrinsic-size alone doesn't update scrollHeight synchronously
      // (intersection observer hasn't re-classified sections yet at after-swap time).
      cvEls.forEach((el, i) => {
        if (savedCvHeights[i] > 0) el.style.height = `${savedCvHeights[i]}px`;
      });
    }

    const maxY0 = document.documentElement.scrollHeight - innerHeight;
    if (targetY <= maxY0) {
      scrollTo({ top: targetY, left: sx, behavior: 'instant' });
      // Defer the explicit-height → intrinsic-size switch until after Alpine.initTree and
      // any other after-swap listeners have run. Switching synchronously causes a transient
      // scrollH drop: on-screen sections measure real content immediately, while off-screen
      // sections lag re-classification under cv:auto. That drop above the viewport, with
      // overflow-anchor still default, makes the browser shift scrollY to keep the visual
      // anchor stable — overshooting the restore. Wait one rAF, lock anchors first, then
      // switch and re-pin atomically.
      requestAnimationFrame(() => {
        if (sig.aborted) return;
        cvEls.forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= innerHeight) el.style.overflowAnchor = 'none';
        });
        if (hasCachedHeights && savedCvHeights) {
          cvEls.forEach((el, i) => {
            el.style.height = '';
            el.style.removeProperty('contain-intrinsic-size');
            if (savedCvHeights[i] > 0) {
              const c = contentHeight(el, savedCvHeights[i]);
              if (c > 0) el.style.setProperty('contain-intrinsic-size', `auto ${c}px`);
            }
          });
        }
        scrollTo({ top: targetY, left: sx, behavior: 'instant' });
        setTimeout(() => {
          if (sig.aborted) return;
          cvEls.forEach(el => { el.style.overflowAnchor = ''; });
        }, anchorResetMs);
      });
      return;
    }

    // Page too short → fall through to flush-and-bake. Covers deep-scroll where saved
    // heights ARE the large values and the page genuinely needs expanding.
    if (hasCachedHeights) {
      for (const el of cvEls) el.style.height = '';
    }
    if (cvEls.length === 0) return;

    // Attempt 1: synchronous in after-swap microtask (same task as router's scrollTo)
    const maxY1 = flushAndFix(cvEls, undefined, flushClass);
    if (!sig.aborted && targetY <= maxY1) {
      scrollTo({ top: targetY, left: sx, behavior: 'instant' });
      return;
    }

    // Attempt 2: double-rAF retry (gives browser an additional layout cycle)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (sig.aborted) return;
      const fresh = [...document.querySelectorAll<HTMLElement>(cvSelector)];
      const maxY2 = flushAndFix(fresh, undefined, flushClass);
      if (targetY <= maxY2) {
        scrollTo({ top: targetY, left: sx, behavior: 'instant' });
        return;
      }
      // Attempt 3 (Chrome 125+): contentvisibilityautostatechange fires when a section
      // unskips; re-issue scrollTo if page finally grew past targetY.
      if ('oncontentvisibilityautostatechange' in HTMLElement.prototype) {
        let scrolled = false;
        const onUnskip = () => {
          if (scrolled || sig.aborted) return;
          if (targetY <= document.documentElement.scrollHeight - innerHeight) {
            scrolled = true;
            scrollTo({ top: targetY, left: sx, behavior: 'instant' });
            fresh.forEach(el => el.removeEventListener('contentvisibilityautostatechange', onUnskip));
          }
        };
        fresh.forEach(el => {
          el.addEventListener('contentvisibilityautostatechange', onUnskip, { signal: sig });
        });
      }
    }));
  };

  // scrollend on window (not document): Safari historically inconsistent about bubbling
  // scrollend through the document, and {passive:true} avoids the default-passive ambiguity.
  window.addEventListener('scrollend', onScrollend, { passive: true });
  document.addEventListener('astro:before-swap', onBeforeSwap);
  document.addEventListener('astro:after-swap', onAfterSwap);

  return () => {
    window.removeEventListener('scrollend', onScrollend);
    document.removeEventListener('astro:before-swap', onBeforeSwap);
    document.removeEventListener('astro:after-swap', onAfterSwap);
    cvRestoreCtrl.abort();
    if (scrollendTimer) clearTimeout(scrollendTimer);
  };
}
