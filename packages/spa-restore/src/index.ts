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
//  - "</script>" inside a string closes the script tag.
// JSON.stringify already escapes U+2028 / U+2029 as of ES2019, so we only
// need to guard the script-tag breaker.
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
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

  const script = [...imports, ...calls].join('\n');

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
