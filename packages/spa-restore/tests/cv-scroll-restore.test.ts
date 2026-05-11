import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { flushAndFix, contentHeight } from '../src/runtime/cv-scroll-restore';

const FLUSH_CLASS = 'cv-auto-restore-flush';

function makeEl(height: number, padY: number = 0): HTMLElement {
  const el = document.createElement('div');
  el.classList.add('cv-auto');
  if (padY > 0) {
    const half = `${padY / 2}px`;
    el.style.paddingTop = half;
    el.style.paddingBottom = half;
  }
  el.getBoundingClientRect = () =>
    ({ height, width: 100, top: 0, left: 0, right: 100, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

// happy-dom's getComputedStyle doesn't reflect inline padding in computed values.
// Override globally so contentHeight() can read the padding we set on test elements.
const origGetComputedStyle = globalThis.getComputedStyle;
beforeEach(() => {
  document.body.innerHTML = '';
  globalThis.getComputedStyle = ((el: Element) => {
    const style = (el as HTMLElement).style;
    return {
      paddingTop: style.paddingTop || '0px',
      paddingBottom: style.paddingBottom || '0px',
    } as CSSStyleDeclaration;
  }) as typeof getComputedStyle;
});
afterEach(() => {
  globalThis.getComputedStyle = origGetComputedStyle;
});

describe('flushAndFix', () => {
  describe('class lifecycle', () => {
    it('adds flush class during getBoundingClientRect call', () => {
      let hadClass = false;
      const el = makeEl(500);
      const origBcr = el.getBoundingClientRect.bind(el);
      el.getBoundingClientRect = () => {
        hadClass = el.classList.contains(FLUSH_CLASS);
        return origBcr();
      };
      flushAndFix([el], () => 0);
      expect(hadClass).toBe(true);
    });

    it('removes flush class after measurement', () => {
      const el = makeEl(500);
      flushAndFix([el], () => 0);
      expect(el.classList.contains(FLUSH_CLASS)).toBe(false);
    });

    it('removes flush class even when multiple elements present', () => {
      const els = [makeEl(400), makeEl(600)];
      flushAndFix(els, () => 0);
      expect(els.every(el => !el.classList.contains(FLUSH_CLASS))).toBe(true);
    });

    it('honors a custom flushClass', () => {
      const CUSTOM = 'my-flush';
      let hadClass = false;
      const el = makeEl(500);
      const origBcr = el.getBoundingClientRect.bind(el);
      el.getBoundingClientRect = () => {
        hadClass = el.classList.contains(CUSTOM);
        return origBcr();
      };
      flushAndFix([el], () => 0, CUSTOM);
      expect(hadClass).toBe(true);
      expect(el.classList.contains(CUSTOM)).toBe(false);
    });
  });

  describe('contain-intrinsic-size baking', () => {
    it('bakes measured height into inline style', () => {
      const el = makeEl(800);
      flushAndFix([el], () => 0);
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 800px');
    });

    it('skips zero-height elements', () => {
      const el = makeEl(0);
      flushAndFix([el], () => 0);
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('');
    });

    it('rounds fractional heights', () => {
      const el = makeEl(0);
      el.getBoundingClientRect = () =>
        ({ height: 800.7, width: 100, top: 0, left: 0, right: 100, bottom: 800.7, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      flushAndFix([el], () => 0);
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 801px');
    });

    it('rounds down when fraction < 0.5', () => {
      const el = makeEl(0);
      el.getBoundingClientRect = () =>
        ({ height: 800.3, width: 100, top: 0, left: 0, right: 100, bottom: 800.3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      flushAndFix([el], () => 0);
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 800px');
    });

    it('applies correct style to each element independently', () => {
      const els = [makeEl(400), makeEl(600), makeEl(0)];
      flushAndFix(els, () => 0);
      expect(els[0].style.getPropertyValue('contain-intrinsic-size')).toBe('auto 400px');
      expect(els[1].style.getPropertyValue('contain-intrinsic-size')).toBe('auto 600px');
      expect(els[2].style.getPropertyValue('contain-intrinsic-size')).toBe('');
    });
  });

  describe('padding subtraction (border-box → content-box)', () => {
    it('subtracts vertical padding when baking intrinsic-size', () => {
      const el = makeEl(800, 128);
      flushAndFix([el], () => 0);
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 672px');
    });

    it('subtracts asymmetric padding correctly', () => {
      const el = makeEl(500, 0);
      el.style.paddingTop = '40px';
      el.style.paddingBottom = '20px';
      flushAndFix([el], () => 0);
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 440px');
    });

    it('clamps to 0 when padding exceeds height', () => {
      const el = makeEl(50, 200);
      flushAndFix([el], () => 0);
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('');
    });

    it('clears prior contain-intrinsic-size before applying new value', () => {
      const el = makeEl(500, 0);
      el.style.setProperty('contain-intrinsic-size', 'auto 9999px');
      flushAndFix([el], () => 0);
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 500px');
    });
  });

  describe('contentHeight helper', () => {
    it('returns box height minus vertical padding', () => {
      const el = makeEl(0, 64);
      expect(contentHeight(el, 1000)).toBe(936);
    });

    it('returns box height when no padding', () => {
      const el = makeEl(0, 0);
      expect(contentHeight(el, 800)).toBe(800);
    });

    it('clamps to 0 when padding > box height', () => {
      const el = makeEl(0, 500);
      expect(contentHeight(el, 200)).toBe(0);
    });
  });

  describe('return value', () => {
    it('returns value from injected getMaxScrollY', () => {
      const el = makeEl(500);
      expect(flushAndFix([el], () => 12649)).toBe(12649);
    });

    it('calls getMaxScrollY after removing flush class', () => {
      const el = makeEl(500);
      let classWhenCalled = '';
      flushAndFix([el], () => {
        classWhenCalled = el.classList.contains(FLUSH_CLASS) ? 'has-flush' : 'no-flush';
        return 0;
      });
      expect(classWhenCalled).toBe('no-flush');
    });

    it('handles empty element array', () => {
      expect(flushAndFix([], () => 500)).toBe(500);
    });
  });
});
