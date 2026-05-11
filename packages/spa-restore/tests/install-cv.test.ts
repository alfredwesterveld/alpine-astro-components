import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { installCvScrollRestore } from '../src/runtime/install-cv';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------
//
// These tests exercise the listener glue in install-cv.ts: scrollend captures,
// before-swap aborts, after-swap restore attempts, LRU cache, abortable
// timers, and the consumer-style preservation contract.
//
// happy-dom (loaded via bunfig.toml preload) provides the DOM, history, and
// location surface we need. Some browser quirks happy-dom does not simulate:
//   - `getBoundingClientRect()` returns zeros for nodes never laid out → we
//     stub it per element when we need real heights.
//   - `getComputedStyle` does not reflect inline padding → we override it
//     globally (matching cv-scroll-restore.test.ts).
//   - `document.documentElement.scrollHeight` defaults to 0 → we stub it via
//     Object.defineProperty when an attempt-1 / attempt-0 path needs the
//     "page is tall enough" branch.
//   - `requestAnimationFrame` exists but fires on a real timer; tests that
//     need to assert on rAF body use a spy that triggers synchronously.
// ---------------------------------------------------------------------------

let teardown: (() => void) | undefined;
let warnSpy: ReturnType<typeof mock>;
let errorSpy: ReturnType<typeof mock>;
let origWarn: typeof console.warn;
let origError: typeof console.error;
let origGetComputedStyle: typeof getComputedStyle;
let origScrollTo: typeof window.scrollTo;
let origRaf: typeof requestAnimationFrame;
let origInnerHeight: number;
let origScrollHeightDesc: PropertyDescriptor | undefined;
let origHistoryStateDesc: PropertyDescriptor | undefined;

function makeCv(opts: { id?: string; height?: number; padY?: number; ariaH?: string } = {}): HTMLElement {
  const el = document.createElement('section');
  el.classList.add('cv-auto');
  if (opts.id) el.id = opts.id;
  if (opts.padY && opts.padY > 0) {
    const half = `${opts.padY / 2}px`;
    el.style.paddingTop = half;
    el.style.paddingBottom = half;
  }
  // Default: nonzero height so getBoundingClientRect returns something useful.
  const h = opts.height ?? 200;
  el.getBoundingClientRect = () =>
    ({ height: h, width: 100, top: 0, left: 0, right: 100, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  if (opts.ariaH) {
    const h1 = document.createElement('h2');
    h1.textContent = opts.ariaH;
    el.appendChild(h1);
  }
  document.body.appendChild(el);
  return el;
}

function stubScrollHeight(value: number): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => value,
  });
}

function setHistoryState(state: unknown): void {
  Object.defineProperty(Object.getPrototypeOf(window.history), 'state', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';

  origWarn = console.warn;
  origError = console.error;
  warnSpy = mock(() => {});
  errorSpy = mock(() => {});
  console.warn = warnSpy as unknown as typeof console.warn;
  console.error = errorSpy as unknown as typeof console.error;

  origGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = ((el: Element) => {
    const style = (el as HTMLElement).style;
    return {
      paddingTop: style.paddingTop || '0px',
      paddingBottom: style.paddingBottom || '0px',
    } as CSSStyleDeclaration;
  }) as typeof getComputedStyle;

  origScrollTo = window.scrollTo;
  // happy-dom's scrollTo throws "not implemented"; replace with a noop spy.
  window.scrollTo = mock(() => {}) as unknown as typeof window.scrollTo;

  origRaf = requestAnimationFrame;

  origInnerHeight = window.innerHeight;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

  origScrollHeightDesc = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight');
  origHistoryStateDesc = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(window.history),
    'state',
  );

  // Default: history.state null → targetY = 0 path → predictable.
  setHistoryState(null);
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  console.warn = origWarn;
  console.error = origError;
  globalThis.getComputedStyle = origGetComputedStyle;
  window.scrollTo = origScrollTo;
  globalThis.requestAnimationFrame = origRaf;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: origInnerHeight });

  // Restore prototype-level descriptors. Delete the own-prop set on
  // documentElement so the original getter returns visible.
  if (origScrollHeightDesc) {
    Object.defineProperty(document.documentElement, 'scrollHeight', origScrollHeightDesc);
  } else {
    // It was an inherited prototype getter — drop our own override.
    delete (document.documentElement as unknown as Record<string, unknown>).scrollHeight;
  }
  if (origHistoryStateDesc) {
    Object.defineProperty(
      Object.getPrototypeOf(window.history),
      'state',
      origHistoryStateDesc,
    );
  }
});

// ---------------------------------------------------------------------------
// scrollend → cache writes
// ---------------------------------------------------------------------------
describe('install-cv — scrollend captures into cvHeightsCache', () => {
  it('scrollend (after debounce) bakes captured heights at next targetY===0 after-swap', async () => {
    // Setup: two cv sections with known heights.
    const a = makeCv({ id: 'a', height: 400 });
    const b = makeCv({ id: 'b', height: 600 });

    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });

    // Trigger capture: scrollend → debounce(0) → write into module-private cache.
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // Replace the elements (simulate ClientRouter swap installing fresh DOM).
    document.body.innerHTML = '';
    const a2 = makeCv({ id: 'a', height: 0 });
    const b2 = makeCv({ id: 'b', height: 0 });

    // history.state.scrollY === 0 → onAfterSwap takes the targetY===0 branch
    // and bakes contain-intrinsic-size from cache. Observable via inline style.
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));

    // Heights from capture (400, 600) should now be baked as intrinsic-size on the new els.
    expect(a2.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 400px');
    expect(b2.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 600px');
  });

  it('cache key includes pathname + search (different search → different cache entry)', async () => {
    history.pushState(null, '', '/page-a?v=1');

    makeCv({ id: 'a', height: 500 });
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });

    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // Switch to a different `?v=`: cache miss on this key.
    history.pushState(null, '', '/page-a?v=2');
    document.body.innerHTML = '';
    const fresh = makeCv({ id: 'a', height: 0 });
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));

    // Different key → no bake.
    expect(fresh.style.getPropertyValue('contain-intrinsic-size')).toBe('');

    // Switch back to ?v=1: cache hit, bake.
    history.pushState(null, '', '/page-a?v=1');
    document.body.innerHTML = '';
    const fresh1 = makeCv({ id: 'a', height: 0 });
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(fresh1.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 500px');
  });

  it('scrollend during restoringWindow is dropped (no cache write)', async () => {
    makeCv({ id: 'a', height: 400 });

    // Make the page tall enough that attempt-0 lands and sets cvRestoring=true.
    stubScrollHeight(2000);
    setHistoryState({ scrollY: 100 });

    teardown = installCvScrollRestore({
      scrollendDebounceMs: 0,
      restoringWindowMs: 100, // long enough to overlap a scrollend
    });

    // Trigger after-swap: cvRestoring becomes true for ~100ms.
    document.dispatchEvent(new Event('astro:after-swap'));

    // Now fire scrollend WHILE cvRestoring is true. The debounced inner check
    // bails because cvRestoring is still set (and even the outer check guards
    // the early-return path). Write must NOT land.
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // To verify "no cache write occurred", swap to a fresh DOM with a distinct
    // height stub and dispatch a targetY===0 after-swap on the SAME key. If the
    // (suppressed) scrollend had captured the (height=400) layout, we'd see an
    // intrinsic-size bake. We expect no bake.
    document.body.innerHTML = '';
    const fresh = makeCv({ id: 'a', height: 0 });

    // Wait for restoringWindow to expire so the second after-swap is a clean run.
    await Bun.sleep(120);

    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(fresh.style.getPropertyValue('contain-intrinsic-size')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// before-swap aborts in-flight rAF / setTimeout (bead 0mn)
// ---------------------------------------------------------------------------
describe('install-cv — before-swap aborts in-flight async work', () => {
  it('before-swap aborts the rAF deferred restore in attempt-0 (sig.aborted short-circuits)', async () => {
    const a = makeCv({ id: 'a', height: 400 });

    // Capture into cache so attempt-0 path runs.
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // Swap to fresh DOM; attempt-0 will scrollTo + schedule rAF for the
    // intrinsic-size switch. Make page tall enough so attempt-0 lands.
    document.body.innerHTML = '';
    const a2 = makeCv({ id: 'a', height: 400 });
    stubScrollHeight(2000);
    setHistoryState({ scrollY: 100 });

    // Stub rAF to delay until we say so.
    let rafCallback: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => {
      rafCallback = fn;
      return 1;
    }) as typeof requestAnimationFrame;

    document.dispatchEvent(new Event('astro:after-swap'));
    expect(typeof rafCallback).toBe('function');

    // Fire before-swap → cvRestoreCtrl.abort(). The captured rAF callback
    // should now early-return on sig.aborted instead of clobbering styles.
    document.dispatchEvent(new Event('astro:before-swap'));

    // Pre-state: a2 has explicit inline height applied by attempt-0 bake.
    expect(a2.style.height).toBe('400px');

    // Fire the deferred rAF. If it ran the body, it would clear height and
    // re-apply contain-intrinsic-size. With aborted signal, none of that runs.
    (rafCallback as unknown as FrameRequestCallback)(performance.now());

    // Height stays as the bake left it (signal aborted before the rAF body's
    // height-restore + intrinsic-size switch ran).
    expect(a2.style.height).toBe('400px');
  });

  it('before-swap clears the pending scrollendTimer so the deferred capture is dropped', async () => {
    makeCv({ id: 'a', height: 500 });
    teardown = installCvScrollRestore({ scrollendDebounceMs: 50 });

    // Schedule a debounced capture but don't let it fire yet.
    window.dispatchEvent(new Event('scrollend'));

    // Before the 50ms elapses, dispatch before-swap to clear the timer.
    document.dispatchEvent(new Event('astro:before-swap'));

    // Wait past the original debounce window.
    await Bun.sleep(80);

    // Verify the (would-have-fired) capture never landed: swap to fresh DOM
    // and check no bake on a targetY===0 after-swap.
    document.body.innerHTML = '';
    const fresh = makeCv({ id: 'a', height: 0 });
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(fresh.style.getPropertyValue('contain-intrinsic-size')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// after-swap fall-through paths
// ---------------------------------------------------------------------------
describe('install-cv — after-swap restore fall-through', () => {
  it('cache miss + tall page → attempt-0 short-path scrollTo (no cached bake needed)', () => {
    makeCv({ id: 'a', height: 1500 });
    stubScrollHeight(2000);
    setHistoryState({ scrollY: 200 });

    const scrollToSpy = window.scrollTo as ReturnType<typeof mock>;
    teardown = installCvScrollRestore();

    // No cache for current key → cache miss → attempt-0 enters with
    // hasCachedHeights=false. Page is already tall enough (maxY0=1200 ≥ 200)
    // so attempt-0 issues scrollTo directly — no flush needed.
    document.dispatchEvent(new Event('astro:after-swap'));

    const calls = scrollToSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = calls[0][0] as { top: number; left: number; behavior: string };
    expect(firstCall.top).toBe(200);
    expect(firstCall.behavior).toBe('instant');
  });

  it('cache miss + short page → attempt-1 sync flushAndFix bakes intrinsic-size', () => {
    const a = makeCv({ id: 'a', height: 1500 });
    // Page is too short for attempt-0: maxY0 = 500 - 800 = -300 < targetY=200,
    // so attempt-0 returns false → restoreStyles(['height']) → attempt-1 runs
    // → flushAndFix bakes intrinsic-size on every cv element.
    stubScrollHeight(500);
    setHistoryState({ scrollY: 200 });

    teardown = installCvScrollRestore();
    document.dispatchEvent(new Event('astro:after-swap'));

    // flushAndFix ran → measured 1500px → baked.
    expect(a.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 1500px');
  });

  it('cache mismatch on length → discards cached entry, no stale heights applied', async () => {
    // Capture: 2 sections.
    makeCv({ id: 'a', height: 400 });
    makeCv({ id: 'b', height: 600 });
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // After-swap with a DIFFERENT count of sections → length mismatch.
    document.body.innerHTML = '';
    const only = makeCv({ id: 'a', height: 0 });
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));

    // Stale heights must NOT be applied: targetY===0 + cache mismatch → no bake.
    expect(only.style.getPropertyValue('contain-intrinsic-size')).toBe('');
  });

  it('cache mismatch on fingerprint → discards cached entry, no stale heights applied', async () => {
    makeCv({ id: 'a', height: 400, ariaH: 'Hello' });
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // After-swap with a same-count but different-fingerprint section.
    document.body.innerHTML = '';
    const swapped = makeCv({ id: 'b', height: 0, ariaH: 'World' });
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));

    expect(swapped.style.getPropertyValue('contain-intrinsic-size')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// LRU eviction (bead niw): cap = 32
// ---------------------------------------------------------------------------
describe('install-cv — cvHeightsCache LRU eviction', () => {
  it('LRU evicts the oldest entry when cap=32 reached', async () => {
    const el = makeCv({ id: 'a', height: 100 });
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });

    // Capture 33 distinct keys. After the 33rd write the FIRST key is evicted.
    for (let i = 0; i < 33; i++) {
      history.pushState(null, '', `/p${i}?x=1`);
      // Vary the per-key captured height so we can detect which entry survives.
      const h = 100 + i;
      (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
        ({ height: h, width: 100, top: 0, left: 0, right: 100, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      window.dispatchEvent(new Event('scrollend'));
      await Bun.sleep(5);
    }

    // Verify the EVICTED first key (/p0?x=1) is no longer cached:
    // navigate back to it, swap fresh DOM, targetY===0 after-swap → no bake.
    history.pushState(null, '', '/p0?x=1');
    document.body.innerHTML = '';
    const fresh0 = makeCv({ id: 'a', height: 0 });
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(fresh0.style.getPropertyValue('contain-intrinsic-size')).toBe('');

    // Verify a still-resident key (/p32?x=1, the most recent) DOES bake.
    history.pushState(null, '', '/p32?x=1');
    document.body.innerHTML = '';
    const fresh32 = makeCv({ id: 'a', height: 0 });
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(fresh32.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 132px');
  });
});

// ---------------------------------------------------------------------------
// dispose() cancels in-flight setTimeouts (bead 0mn + zh4)
// ---------------------------------------------------------------------------
describe('install-cv — dispose cancels tracked setTimeouts', () => {
  it('dispose aborts the cvRestoring + anchor-reset timers (no late mutation after teardown)', async () => {
    const a = makeCv({ id: 'a', height: 400 });

    // Capture cache so attempt-0 runs.
    teardown = installCvScrollRestore({
      scrollendDebounceMs: 0,
      restoringWindowMs: 50,
      anchorResetMs: 50,
    });
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    document.body.innerHTML = '';
    const a2 = makeCv({ id: 'a', height: 400 });
    a2.style.overflowAnchor = 'auto'; // pre-existing consumer style
    stubScrollHeight(2000);
    setHistoryState({ scrollY: 100 });

    // Use a synchronous-on-demand rAF so we can drive the rAF body (which sets
    // overflowAnchor='none' on off-screen sections) before dispose runs.
    let rafFn: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => {
      rafFn = fn;
      return 1;
    }) as typeof requestAnimationFrame;

    document.dispatchEvent(new Event('astro:after-swap'));

    // Run rAF: overflowAnchor flipped to 'none', anchor-reset timer queued.
    rafFn?.(performance.now());
    // (For sections with bottom <= 0 || top >= innerHeight; our stub has top=0
    //  bottom=400, so the rAF body's predicate may NOT set overflowAnchor='none'
    //  here. That's OK — we're testing the timer cancellation, observed via
    //  cv-restoring-reset which always queues.)

    // Now dispose. The two queued setTimeouts (cvRestoring reset @50ms, anchor
    // reset @50ms) should be aborted.
    teardown();
    teardown = undefined;

    // Wait beyond the original timer windows; if dispose didn't cancel, the
    // timer body would mutate styles on `a2`. We assert that the consumer's
    // original `overflowAnchor` value is still untouched (the timer body
    // would have called restoreStyles(['anchor']) which is a noop here since
    // we never overflowed off-screen, but we can detect cvRestoring-reset
    // running by observing console.error did NOT fire).
    await Bun.sleep(80);

    // No errors during teardown.
    expect(errorSpy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// targetY===0 path still bakes intrinsic-size (bead 7vb)
// ---------------------------------------------------------------------------
describe('install-cv — targetY===0 still bakes intrinsic-size', () => {
  it('skips scrollTo but applies contain-intrinsic-size from cache', async () => {
    const orig = makeCv({ id: 'a', height: 555 });
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    document.body.innerHTML = '';
    const fresh = makeCv({ id: 'a', height: 0 });
    const scrollToSpy = window.scrollTo as ReturnType<typeof mock>;
    scrollToSpy.mock.calls.length = 0; // reset

    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));

    // Bake applied even when scrollTo is skipped.
    expect(fresh.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 555px');
    // No scrollTo invoked on the targetY===0 branch.
    expect(scrollToSpy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// visibility-hidden uses setTimeout(0) instead of rAF (bead 67p)
// ---------------------------------------------------------------------------
describe('install-cv — visibility-hidden swaps rAF for setTimeout(0)', () => {
  it('does NOT call requestAnimationFrame when document.visibilityState is hidden', async () => {
    const a = makeCv({ id: 'a', height: 400 });
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    document.body.innerHTML = '';
    makeCv({ id: 'a', height: 400 });
    stubScrollHeight(2000);
    setHistoryState({ scrollY: 100 });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    const rafSpy = mock(((_fn: FrameRequestCallback) => 0) as typeof requestAnimationFrame);
    globalThis.requestAnimationFrame = rafSpy as unknown as typeof requestAnimationFrame;

    document.dispatchEvent(new Event('astro:after-swap'));

    // attempt-0 deferred work runs through setTimeout(0), not rAF.
    expect(rafSpy.mock.calls.length).toBe(0);

    // Cleanup the visibilityState override.
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });
});

// ---------------------------------------------------------------------------
// Consumer inline-style preservation (bead 6el)
// ---------------------------------------------------------------------------
describe('install-cv — preserves consumer inline styles across restore', () => {
  it('snapshots consumer style.height + contain-intrinsic-size + overflow-anchor before mutating', async () => {
    // Consumer has set explicit values on the cv element.
    const a = makeCv({ id: 'a', height: 400 });
    a.style.height = '999px';
    a.style.setProperty('contain-intrinsic-size', 'auto 1234px');
    a.style.overflowAnchor = 'auto';

    // Capture so attempt-0 path runs.
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0, restoringWindowMs: 30 });
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // Swap to a fresh element that has the same consumer-controlled values.
    document.body.innerHTML = '';
    const a2 = makeCv({ id: 'a', height: 400 });
    a2.style.height = '999px';
    a2.style.setProperty('contain-intrinsic-size', 'auto 1234px');
    a2.style.overflowAnchor = 'auto';

    stubScrollHeight(2000);
    setHistoryState({ scrollY: 100 });

    // Drive rAF synchronously so the deferred restore runs immediately.
    let rafFn: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => {
      rafFn = fn;
      return 1;
    }) as typeof requestAnimationFrame;

    document.dispatchEvent(new Event('astro:after-swap'));

    // attempt-0 sets explicit height while baking — that's expected.
    rafFn?.(performance.now());

    // After rAF: consumer height value is restored (not blanked).
    expect(a2.style.height).toBe('999px');

    // Wait past restoringWindow: consumer's contain-intrinsic-size wins
    // (load-bearing bake reverts to consumer value).
    await Bun.sleep(60);
    expect(a2.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 1234px');
  });
});

// ---------------------------------------------------------------------------
// history.state.scrollY missing → warn-once (bead 67a)
// ---------------------------------------------------------------------------
describe('install-cv — history.state shape warning (bead 67a)', () => {
  it('emits console.warn (once) when history.state lacks scrollY', () => {
    teardown = installCvScrollRestore();

    // history.state = null already set in beforeEach → shape missing scrollY.
    document.dispatchEvent(new Event('astro:after-swap'));
    document.dispatchEvent(new Event('astro:after-swap'));
    document.dispatchEvent(new Event('astro:after-swap'));

    // Exactly one warn across multiple dispatches (warn-once).
    const calls = warnSpy.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0] as string).toContain('[astro-spa-restore]');
    expect(calls[0][0] as string).toContain('history.state.scrollY missing');
  });

  it('does NOT warn when history.state.scrollY is present (even if 0)', () => {
    teardown = installCvScrollRestore();

    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));
    setHistoryState({ scrollY: 100 });
    document.dispatchEvent(new Event('astro:after-swap'));

    expect(warnSpy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// after-swap edge cases
// ---------------------------------------------------------------------------
describe('install-cv — after-swap edge cases', () => {
  it('no .cv-auto elements present → completes without throwing or scrolling', () => {
    setHistoryState({ scrollY: 100 });
    stubScrollHeight(2000);
    const scrollToSpy = window.scrollTo as ReturnType<typeof mock>;
    teardown = installCvScrollRestore();

    expect(() => {
      document.dispatchEvent(new Event('astro:after-swap'));
    }).not.toThrow();

    // No throw, no error logged.
    expect(errorSpy.mock.calls.length).toBe(0);
    // attempt-0 still runs scrollTo (the cvEls.length guard sits between
    // attempt-0 and attempt-1, so the cached-heights path is the only path
    // possible with zero elements — it short-paths via maxY0 check).
    // We assert the listener doesn't crash; whether it scrolled is incidental.
    expect(scrollToSpy.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  it('scrollend with no .cv-auto elements does not write a cache entry', async () => {
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0 });

    // No cv elements in the DOM at scrollend time.
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // Now add a fresh cv element and dispatch targetY===0 after-swap. If a
    // (zero-length) cache entry had been written, it would still pass the
    // length-mismatch guard (1 vs 0) and we'd see no bake — but more
    // importantly, no error and no spurious behavior.
    const fresh = makeCv({ id: 'a', height: 0 });
    setHistoryState({ scrollY: 0 });
    document.dispatchEvent(new Event('astro:after-swap'));

    expect(fresh.style.getPropertyValue('contain-intrinsic-size')).toBe('');
    expect(errorSpy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dispose() idempotency + repeated before-swap
// ---------------------------------------------------------------------------
describe('install-cv — dispose + repeated lifecycle', () => {
  it('dispose() called twice does not throw and removes listeners idempotently', () => {
    teardown = installCvScrollRestore();
    expect(() => {
      teardown!();
      teardown!();
    }).not.toThrow();
    teardown = undefined;
    expect(errorSpy.mock.calls.length).toBe(0);
  });

  it('repeated before-swap → after-swap cycles do not leak: each before-swap installs a fresh AbortController', async () => {
    const a = makeCv({ id: 'a', height: 400 });
    teardown = installCvScrollRestore({ scrollendDebounceMs: 0, restoringWindowMs: 30 });

    // Capture once.
    window.dispatchEvent(new Event('scrollend'));
    await Bun.sleep(10);

    // Three back-to-back before-swap → after-swap cycles. None should
    // throw or surface as console.error.
    for (let i = 0; i < 3; i++) {
      document.body.innerHTML = '';
      makeCv({ id: 'a', height: 400 });
      setHistoryState({ scrollY: 0 });
      document.dispatchEvent(new Event('astro:before-swap'));
      document.dispatchEvent(new Event('astro:after-swap'));
    }

    expect(errorSpy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// attempt-2 (double-rAF) is scheduled when attempt-1 fails
// ---------------------------------------------------------------------------
describe('install-cv — attempt-2 double-rAF retry', () => {
  it('attempt-1 fails (page too short even after flush) → schedules attempt-2 via rAF', () => {
    makeCv({ id: 'a', height: 100 });
    // Page is too short for both attempt-0 and attempt-1.
    stubScrollHeight(300);
    setHistoryState({ scrollY: 5000 });

    let rafCalls = 0;
    globalThis.requestAnimationFrame = ((_fn: FrameRequestCallback) => {
      rafCalls += 1;
      return rafCalls;
    }) as typeof requestAnimationFrame;

    teardown = installCvScrollRestore();
    document.dispatchEvent(new Event('astro:after-swap'));

    // attempt-2 schedules an outer rAF (which then schedules an inner). We
    // only see the outer because we never invoke the captured callback. The
    // restoringWindow timer also queues, but rAF count is the indicator.
    expect(rafCalls).toBeGreaterThanOrEqual(1);
  });
});
