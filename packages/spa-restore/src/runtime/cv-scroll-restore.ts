const FLUSH_CLASS = 'cv-auto-restore-flush';

// contain-intrinsic-size sizes the CONTENT box. getBoundingClientRect returns the
// BORDER box (content + padding + border). When a cv:auto section is skipped, browser
// computes outer = padding-top + intrinsic-size + padding-bottom + border-top + border-bottom
// — so baking border-box height into intrinsic-size makes skipped sections render too tall
// by exactly their vertical padding + borders.
export function contentHeight(el: HTMLElement, boxHeight: number): number {
  const cs = getComputedStyle(el);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  return Math.max(0, boxHeight - padY - borderY);
}

/**
 * Flushes content-visibility:auto sections to real heights, bakes those heights
 * into inline contain-intrinsic-size, then restores cv:auto.
 *
 * Why: after ClientRouter replaces body, new DOM nodes lose remembered heights →
 * cv:auto off-screen sections collapse to their intrinsic-size placeholder (800px) →
 * page shrinks → router's scrollTo(savedY) gets browser-clamped.
 *
 * Baking the measured heights prevents re-collapse when sections go off-screen again.
 *
 * @param els           - .cv-auto section elements to flush
 * @param getMaxScrollY - injectable for testing; defaults to scrollHeight - innerHeight
 * @param flushClass    - CSS class toggled to force content-visibility:visible (default 'cv-auto-restore-flush')
 * @returns               max scrollable Y after cv:auto resumes
 */
export function flushAndFix(
  els: HTMLElement[],
  getMaxScrollY: () => number = () => document.documentElement.scrollHeight - window.innerHeight,
  flushClass: string = FLUSH_CLASS,
): number {
  els.forEach(el => el.classList.add(flushClass));
  const heights = els.map(el => Math.round(el.getBoundingClientRect().height));
  els.forEach((el, i) => {
    el.style.removeProperty('contain-intrinsic-size');
    if (heights[i] > 0) {
      const c = contentHeight(el, heights[i]);
      if (c > 0) el.style.setProperty('contain-intrinsic-size', `auto ${c}px`);
    }
  });
  els.forEach(el => el.classList.remove(flushClass));
  return getMaxScrollY();
}
