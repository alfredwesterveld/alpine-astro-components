import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { installAlpineLifecycle } from '../src/runtime/install-alpine';

interface AlpineStub {
  initTree: ReturnType<typeof mock>;
  destroyTree: ReturnType<typeof mock>;
  mutateDom: ReturnType<typeof mock>;
}

declare global {
  interface Window {
    Alpine?: AlpineStub;
  }
}

function makeAlpineStub(opts: { destroyImpl?: (el: Element) => void } = {}): AlpineStub {
  return {
    initTree: mock(() => {}),
    destroyTree: mock((el: Element) => {
      opts.destroyImpl?.(el);
    }),
    mutateDom: mock((cb: () => void) => cb()),
  };
}

let teardown: (() => void) | undefined;
let warnSpy: ReturnType<typeof mock> | undefined;
let origWarn: typeof console.warn;

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as Window).Alpine;
  origWarn = console.warn;
  warnSpy = mock(() => {});
  console.warn = warnSpy as unknown as typeof console.warn;
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  console.warn = origWarn;
  delete (window as Window).Alpine;
});

describe('installAlpineLifecycle — destroyTree walk', () => {
  it('snapshots children to a static array (skq): mutating during destroy does not skip siblings', () => {
    // Build three sibling sections under body.
    const a = document.createElement('section');
    const b = document.createElement('section');
    const c = document.createElement('section');
    a.id = 'a';
    b.id = 'b';
    c.id = 'c';
    document.body.append(a, b, c);

    const destroyed: string[] = [];
    // destroyImpl removes the element from its parent — simulating the kind of
    // DOM mutation that destroyTree may trigger via cleanup callbacks. With a
    // live HTMLCollection, removing `a` would shift `b`/`c` and skip one.
    window.Alpine = makeAlpineStub({
      destroyImpl: (el) => {
        destroyed.push((el as Element).id);
        el.parentNode?.removeChild(el);
      },
    });
    teardown = installAlpineLifecycle();

    document.dispatchEvent(new Event('astro:before-swap'));

    // All three siblings must be destroyed despite live-collection mutation.
    expect(destroyed).toEqual(['a', 'b', 'c']);
  });

  it('persist-walk (6a9): destroys ancestor of persist node but not the persist node itself', () => {
    // Fixture from bead:
    // <body>
    //   <section x-data>                                  ← must be destroyed
    //     <div data-astro-transition-persist x-data />    ← must be skipped
    //   </section>
    //   <article x-data />                                ← must be destroyed
    // </body>
    const section = document.createElement('section');
    section.id = 'section';
    const persisted = document.createElement('div');
    persisted.id = 'persisted';
    persisted.setAttribute('data-astro-transition-persist', '');
    section.appendChild(persisted);

    const article = document.createElement('article');
    article.id = 'article';

    document.body.append(section, article);

    const destroyed: string[] = [];
    window.Alpine = makeAlpineStub({
      destroyImpl: (el) => {
        destroyed.push((el as Element).id);
      },
    });
    teardown = installAlpineLifecycle();

    document.dispatchEvent(new Event('astro:before-swap'));

    // Ancestor destroyed; persisted descendant skipped; sibling destroyed.
    expect(destroyed).toContain('section');
    expect(destroyed).toContain('article');
    expect(destroyed).not.toContain('persisted');
  });

  it('persist-walk: persisted root skips entirely (no recurse, no destroy of itself)', () => {
    // A persisted top-level child must be left alone — neither destroyed nor
    // walked into.
    const persistedRoot = document.createElement('section');
    persistedRoot.id = 'persistedRoot';
    persistedRoot.setAttribute('data-astro-transition-persist', '');
    const inner = document.createElement('div');
    inner.id = 'inner';
    persistedRoot.appendChild(inner);
    document.body.appendChild(persistedRoot);

    const destroyed: string[] = [];
    window.Alpine = makeAlpineStub({
      destroyImpl: (el) => destroyed.push((el as Element).id),
    });
    teardown = installAlpineLifecycle();

    document.dispatchEvent(new Event('astro:before-swap'));

    expect(destroyed).toEqual([]);
  });
});

describe('installAlpineLifecycle — Alpine missing warning (m3w)', () => {
  it('warns at most once per missing-Alpine episode across before/after-swap', () => {
    teardown = installAlpineLifecycle();

    // Alpine missing on first before-swap → warn once.
    document.dispatchEvent(new Event('astro:before-swap'));
    expect(warnSpy!.mock.calls.length).toBe(1);

    // Still missing on after-swap → no second warn (same episode).
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(warnSpy!.mock.calls.length).toBe(1);

    // Still missing on subsequent swaps → no extra warns.
    document.dispatchEvent(new Event('astro:before-swap'));
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(warnSpy!.mock.calls.length).toBe(1);
  });

  it('resets warning gate when Alpine reappears, allowing one warn on next disappearance', () => {
    teardown = installAlpineLifecycle();

    // Episode 1: Alpine missing → warn.
    document.dispatchEvent(new Event('astro:before-swap'));
    expect(warnSpy!.mock.calls.length).toBe(1);

    // Alpine reappears — successful swap should reset the warn gate.
    window.Alpine = makeAlpineStub();
    document.dispatchEvent(new Event('astro:before-swap'));
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(warnSpy!.mock.calls.length).toBe(1); // no new warns while present

    // Alpine disappears again → exactly one new warn.
    delete (window as Window).Alpine;
    document.dispatchEvent(new Event('astro:before-swap'));
    expect(warnSpy!.mock.calls.length).toBe(2);

    // And still no extra on the after-swap of the same episode.
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(warnSpy!.mock.calls.length).toBe(2);
  });
});

describe('installAlpineLifecycle — initTree on after-swap', () => {
  it('calls Alpine.initTree(document.body) when Alpine is present', () => {
    const stub = makeAlpineStub();
    window.Alpine = stub;
    teardown = installAlpineLifecycle();

    document.dispatchEvent(new Event('astro:after-swap'));

    expect(stub.initTree.mock.calls.length).toBe(1);
    expect(stub.initTree.mock.calls[0][0]).toBe(document.body);
  });
});
