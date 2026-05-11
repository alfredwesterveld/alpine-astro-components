import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { installCvScrollRestore } from '../src/runtime/install-cv';
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

let teardown: (() => void) | undefined;
let errorSpy: ReturnType<typeof mock> | undefined;
let origError: typeof console.error;
let origWarn: typeof console.warn;
let origHistoryStateDesc: PropertyDescriptor | undefined;

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as Window).Alpine;
  origError = console.error;
  origWarn = console.warn;
  errorSpy = mock(() => {});
  console.error = errorSpy as unknown as typeof console.error;
  // Silence the once-warnedMissingScrollY warning emitted by install-cv
  // when history.state is poisoned — it's not what these tests assert.
  console.warn = mock(() => {}) as unknown as typeof console.warn;
  origHistoryStateDesc = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(window.history),
    'state',
  );
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  console.error = origError;
  console.warn = origWarn;
  delete (window as Window).Alpine;
  // Restore original history.state descriptor if we poisoned it.
  if (origHistoryStateDesc) {
    Object.defineProperty(
      Object.getPrototypeOf(window.history),
      'state',
      origHistoryStateDesc,
    );
  }
});

describe('install-cv error boundary (od4)', () => {
  it('catches throws from poisoned history.state in onAfterSwap and reports via console.error', () => {
    teardown = installCvScrollRestore();

    // Poison history.state to throw on read — this is what onAfterSwap reads first.
    Object.defineProperty(Object.getPrototypeOf(window.history), 'state', {
      configurable: true,
      get() {
        throw new Error('poisoned-history-state');
      },
    });

    // Must NOT throw out of dispatchEvent — listener must catch.
    expect(() => {
      document.dispatchEvent(new Event('astro:after-swap'));
    }).not.toThrow();

    // console.error called with the package-prefixed label and the underlying error.
    const calls = errorSpy!.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0] as string).toContain('[astro-spa-restore]');
    expect((calls[0][1] as Error).message).toBe('poisoned-history-state');
  });
});

describe('install-alpine error boundary (od4)', () => {
  it('catches throws from Alpine.mutateDom in onBeforeSwap and reports via console.error', () => {
    window.Alpine = {
      initTree: mock(() => {}),
      destroyTree: mock(() => {}),
      mutateDom: mock(() => {
        throw new Error('mutate-dom-boom');
      }),
    };
    teardown = installAlpineLifecycle();

    expect(() => {
      document.dispatchEvent(new Event('astro:before-swap'));
    }).not.toThrow();

    const calls = errorSpy!.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0] as string).toContain('[astro-spa-restore]');
    expect((calls[0][1] as Error).message).toBe('mutate-dom-boom');
  });

  it('catches throws from Alpine.initTree in onAfterSwap and reports via console.error', () => {
    window.Alpine = {
      initTree: mock(() => {
        throw new Error('init-tree-boom');
      }),
      destroyTree: mock(() => {}),
      mutateDom: mock((cb: () => void) => cb()),
    };
    teardown = installAlpineLifecycle();

    expect(() => {
      document.dispatchEvent(new Event('astro:after-swap'));
    }).not.toThrow();

    const calls = errorSpy!.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0] as string).toContain('[astro-spa-restore]');
    expect((calls[0][1] as Error).message).toBe('init-tree-boom');
  });

  it('after a throw in onBeforeSwap, onAfterSwap still fires (handlers are independent)', () => {
    let initCalled = false;
    window.Alpine = {
      initTree: mock(() => {
        initCalled = true;
      }),
      destroyTree: mock(() => {}),
      mutateDom: mock(() => {
        throw new Error('first-handler-boom');
      }),
    };
    teardown = installAlpineLifecycle();

    // First handler throws but is caught.
    expect(() => {
      document.dispatchEvent(new Event('astro:before-swap'));
    }).not.toThrow();
    expect(initCalled).toBe(false);

    // Second handler still fires successfully — proves the catch in
    // onBeforeSwap didn't poison the listener registration / global state.
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(initCalled).toBe(true);
  });
});
