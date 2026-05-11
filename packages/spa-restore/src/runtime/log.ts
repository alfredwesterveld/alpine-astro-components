// Internal logger helper. Centralizes the `[astro-spa-restore]` prefix so that
// every diagnostic from this package is greppable from a single string and
// future routing (e.g. consumer-supplied logger) needs only one switch.
const PREFIX = '[astro-spa-restore]';

export function log(level: 'warn' | 'error', msg: string, ...rest: unknown[]): void {
  // eslint-disable-next-line no-console
  console[level](`${PREFIX} ${msg}`, ...rest);
}
