import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import type { CvOpts } from './runtime/install-cv';
import type { AlpineOpts } from './runtime/install-alpine';

export interface SpaRestoreOptions extends CvOpts, AlpineOpts {
  /** Wire Alpine destroyTree/initTree on every swap. Default false. */
  alpine?: boolean;
  /** Auto-inject the .cv-auto utility CSS. Default true. */
  injectStyles?: boolean;
}

const PKG = '@alfredwesterveld/astro-spa-restore';

// Conservative identifier shapes for values that get interpolated into CSS
// selectors at runtime by ./runtime/install-cv + ./runtime/install-alpine.
// Keeping these strict at the integration boundary means downstream selector
// builders never see hostile input (defense in depth for the JSON injection
// fix below).
const CLASS_RE = /^[A-Za-z_-][\w-]*$/;
const ATTR_RE = /^[a-z][a-z0-9-]*$/;

function validate(name: string, value: unknown, re: RegExp): void {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new Error(`${PKG}: invalid ${name}: ${JSON.stringify(value)}`);
  }
}

// JSON.stringify is *not* safe for embedding directly inside a <script> body:
//  - "</script>" inside a string closes the script tag
//  - U+2028 / U+2029 are valid JSON but illegal raw inside a JS string literal
//    (they terminate lines per ECMAScript pre-ES2019 and still break some
//    parsers/minifiers).
// Escape all three so the emitted runtime is safe regardless of the option
// string's contents (and regardless of how Astro inlines the script).
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export default function spaRestore(options: SpaRestoreOptions = {}): AstroIntegration {
  const { alpine = false, injectStyles = true, persistAttribute, ...cvOpts } = options;

  // Validate every user-supplied identifier before it is interpolated into JS
  // source or CSS selectors. Throwing here surfaces misconfig at `astro build`
  // / `astro dev` startup with an actionable message.
  if (cvOpts.cvClass !== undefined) validate('cvClass', cvOpts.cvClass, CLASS_RE);
  if (cvOpts.flushClass !== undefined) validate('flushClass', cvOpts.flushClass, CLASS_RE);
  if (persistAttribute !== undefined) validate('persistAttribute', persistAttribute, ATTR_RE);

  const imports: string[] = [];
  const calls: string[] = [];

  if (injectStyles) imports.push(`import '${PKG}/styles/cv-auto.css';`);

  imports.push(`import { installCvScrollRestore } from '${PKG}/runtime/cv';`);
  calls.push(`installCvScrollRestore(${safeJson(cvOpts)});`);

  if (alpine) {
    imports.push(`import { installAlpineLifecycle } from '${PKG}/runtime/alpine';`);
    const alpineOpts = persistAttribute ? { persistAttribute } : {};
    calls.push(`installAlpineLifecycle(${safeJson(alpineOpts)});`);
  }

  // ClientRouter detection (bead tzh): on pages without <ClientRouter />, the
  // `astro:before-swap` event never fires, but `astro:after-swap` could in
  // principle be dispatched by other code (or future Astro changes), so we
  // gate it. Strategy: a capture-phase listener on `astro:after-swap` short-
  // circuits all other handlers (stopImmediatePropagation) until we've seen
  // at least one real `astro:before-swap`, OR until 5s after load have passed
  // (after which we trust that no ClientRouter is active and continue gating
  // forever — pages that never use view transitions stay inert).
  //
  // We use a timer rather than feature-detecting <astro-island> because a
  // page can opt into ClientRouter without using any islands — that would
  // false-negative on those pages.
  const guard = `(() => {
  let crSeen = false, deadline = false;
  document.addEventListener('astro:before-swap', () => { crSeen = true; }, { capture: true });
  setTimeout(() => { deadline = true; }, 5000);
  document.addEventListener('astro:after-swap', (e) => {
    if (!crSeen && deadline) {
      e.stopImmediatePropagation();
    }
  }, { capture: true });
})();`;

  const script = [guard, ...imports, ...calls].join('\n');

  return {
    name: PKG,
    hooks: {
      'astro:config:setup': ({ injectScript, config }) => {
        // Bead 3ze: when alpine:true, fail fast at integration setup if
        // alpinejs cannot be resolved from the consumer's project root. The
        // runtime call site (install-alpine.ts) only console.warns at runtime,
        // which silently degrades the entire reason a consumer enabled alpine.
        if (alpine) {
          const root = config?.root;
          const rootPath = root
            ? typeof root === 'string'
              ? root
              : root instanceof URL
                ? fileURLToPath(root)
                : String(root)
            : process.cwd();
          const req = createRequire(import.meta.url);
          try {
            req.resolve('alpinejs', { paths: [rootPath] });
          } catch {
            throw new Error(
              `${PKG}: option \`alpine: true\` requires the optional peer dependency \`alpinejs\`, but it could not be resolved from ${rootPath}. Install it with: bun add alpinejs`,
            );
          }
        }

        injectScript('page', script);
      },
    },
  };
}

export type { CvOpts, AlpineOpts };
