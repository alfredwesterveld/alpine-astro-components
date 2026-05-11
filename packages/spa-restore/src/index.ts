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

export default function spaRestore(options: SpaRestoreOptions = {}): AstroIntegration {
  const { alpine = false, injectStyles = true, persistAttribute, ...cvOpts } = options;

  const imports: string[] = [];
  const calls: string[] = [];

  if (injectStyles) imports.push(`import '${PKG}/styles/cv-auto.css';`);

  imports.push(`import { installCvScrollRestore } from '${PKG}/runtime/cv';`);
  calls.push(`installCvScrollRestore(${JSON.stringify(cvOpts)});`);

  if (alpine) {
    imports.push(`import { installAlpineLifecycle } from '${PKG}/runtime/alpine';`);
    const alpineOpts = persistAttribute ? { persistAttribute } : {};
    calls.push(`installAlpineLifecycle(${JSON.stringify(alpineOpts)});`);
  }

  const script = imports.concat(calls).join('\n');

  return {
    name: PKG,
    hooks: {
      'astro:config:setup': ({ injectScript }) => {
        injectScript('page', script);
      },
    },
  };
}

export type { CvOpts, AlpineOpts };
