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

  it('persist-walk (6a9): destroys ancestor but detaches persisted descendant first so real Alpine.destroyTree (deep walker) cannot reach it', () => {
    // Fixture from bead:
    // <body>
    //   <section x-data>                                  ← must be destroyed
    //     <div data-astro-transition-persist x-data />    ← must be skipped (and detached during destroy)
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
    // Track whether the persisted node was attached to `section` at the moment
    // destroyTree(section) fires. With real Alpine, destroyTree walks
    // descendants and runs cleanup hooks on every reachable Alpine node, so
    // the persisted descendant MUST be detached first.
    let persistedReachableDuringDestroy: boolean | undefined;
    window.Alpine = makeAlpineStub({
      destroyImpl: (el) => {
        destroyed.push((el as Element).id);
        if ((el as Element).id === 'section') {
          persistedReachableDuringDestroy = (el as Element).contains(persisted);
        }
      },
    });
    teardown = installAlpineLifecycle();

    document.dispatchEvent(new Event('astro:before-swap'));

    // Ancestor destroyed; persisted descendant never has destroyTree called on it.
    expect(destroyed).toContain('section');
    expect(destroyed).toContain('article');
    expect(destroyed).not.toContain('persisted');
    // Persisted descendant must be detached before its ancestor is destroyed,
    // otherwise real Alpine's deep walker would tear down its state.
    expect(persistedReachableDuringDestroy).toBe(false);
    // After the handler completes, the persisted node is re-attached at its
    // original location so Astro's view-transition can find + move it.
    expect(section.contains(persisted)).toBe(true);
    expect(persisted.parentNode).toBe(section);
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

describe('installAlpineLifecycle — persist-walk detach/destroy/reattach (deep)', () => {
  it('detaches a deeply-nested (3+ levels) persisted node before destroying its ancestor', () => {
    // Fixture:
    // <body>
    //   <section id="root">                        ← top-level child, must be destroyed
    //     <div id="lvl2">
    //       <article id="lvl3">
    //         <span id="persisted" data-astro-transition-persist />
    //       </article>
    //     </div>
    //   </section>
    // </body>
    const root = document.createElement('section');
    root.id = 'root';
    const lvl2 = document.createElement('div');
    lvl2.id = 'lvl2';
    const lvl3 = document.createElement('article');
    lvl3.id = 'lvl3';
    const persisted = document.createElement('span');
    persisted.id = 'persisted';
    persisted.setAttribute('data-astro-transition-persist', '');
    lvl3.appendChild(persisted);
    lvl2.appendChild(lvl3);
    root.appendChild(lvl2);
    document.body.appendChild(root);

    const destroyed: string[] = [];
    let persistedReachableDuringDestroy: boolean | undefined;
    window.Alpine = makeAlpineStub({
      destroyImpl: (el) => {
        destroyed.push((el as Element).id);
        if ((el as Element).id === 'root') {
          // Real Alpine.destroyTree deep-walks this subtree — assert the
          // persisted node is NOT reachable from the ancestor at this point.
          persistedReachableDuringDestroy = (el as Element).contains(persisted);
        }
      },
    });
    teardown = installAlpineLifecycle();

    document.dispatchEvent(new Event('astro:before-swap'));

    expect(destroyed).toContain('root');
    expect(destroyed).not.toContain('persisted');
    expect(persistedReachableDuringDestroy).toBe(false);

    // After the handler completes, the persisted node is re-attached at its
    // original location (inside lvl3, inside lvl2, inside root).
    expect(lvl3.contains(persisted)).toBe(true);
    expect(persisted.parentNode).toBe(lvl3);
  });

  it('preserves multiple persisted nodes at different depths in a single swap', () => {
    // Fixture:
    // <body>
    //   <section id="A">
    //     <span id="persistA" data-astro-transition-persist />          ← depth 1
    //   </section>
    //   <article id="B">
    //     <div>
    //       <p id="persistB" data-astro-transition-persist />            ← depth 2
    //     </div>
    //   </article>
    //   <main id="C">                                                    ← no persisted descendants
    //   </main>
    // </body>
    const a = document.createElement('section');
    a.id = 'A';
    const persistA = document.createElement('span');
    persistA.id = 'persistA';
    persistA.setAttribute('data-astro-transition-persist', '');
    a.appendChild(persistA);

    const b = document.createElement('article');
    b.id = 'B';
    const inner = document.createElement('div');
    const persistB = document.createElement('p');
    persistB.id = 'persistB';
    persistB.setAttribute('data-astro-transition-persist', '');
    inner.appendChild(persistB);
    b.appendChild(inner);

    const c = document.createElement('main');
    c.id = 'C';

    document.body.append(a, b, c);

    const destroyed: string[] = [];
    const reachableSnapshot: Record<string, { hasA: boolean; hasB: boolean }> = {};
    window.Alpine = makeAlpineStub({
      destroyImpl: (el) => {
        const id = (el as Element).id;
        destroyed.push(id);
        reachableSnapshot[id] = {
          hasA: (el as Element).contains(persistA),
          hasB: (el as Element).contains(persistB),
        };
      },
    });
    teardown = installAlpineLifecycle();

    document.dispatchEvent(new Event('astro:before-swap'));

    // All three top-level children destroyed; neither persisted node destroyed.
    expect(destroyed).toEqual(['A', 'B', 'C']);
    expect(destroyed).not.toContain('persistA');
    expect(destroyed).not.toContain('persistB');

    // Persisted descendants must be unreachable from their ancestors at the
    // moment destroyTree fires — otherwise real Alpine's deep walker tears
    // them down via cleanup hooks.
    expect(reachableSnapshot['A']!.hasA).toBe(false);
    expect(reachableSnapshot['B']!.hasB).toBe(false);

    // After the handler completes, both persisted nodes are re-attached at
    // their original positions and the surrounding structure is intact.
    expect(persistA.parentNode).toBe(a);
    expect(persistB.parentNode).toBe(inner);
    expect(inner.parentNode).toBe(b);
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

describe('installAlpineLifecycle — nested persisted elements', () => {
  it('does not crash when persisted elements are nested', () => {
    const outer = document.createElement('div');
    outer.setAttribute('data-astro-transition-persist', '');
    const inner = document.createElement('span');
    inner.setAttribute('data-astro-transition-persist', '');
    outer.appendChild(inner);
    document.body.appendChild(outer);

    window.Alpine = makeAlpineStub();
    teardown = installAlpineLifecycle();

    expect(() => document.dispatchEvent(new Event('astro:before-swap'))).not.toThrow();
    expect(outer.contains(inner)).toBe(true);
  });
});
