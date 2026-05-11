# alpine-astro-components

Reusable Astro + Alpine.js building blocks. Bun workspaces monorepo.

## Packages

| Package | What |
|---|---|
| [`@alfred.westerveld/astro-spa-restore`](./packages/spa-restore) | Astro integration: cv-auto scroll-restore + Alpine destroy/init lifecycle for `<ClientRouter />` view-transition swaps. |

## Develop

```bash
bun install
bun run build           # build all packages
bun run test            # test all packages
```

## Consume locally (file: dep)

From a sibling project:

```bash
bun add @alfred.westerveld/astro-spa-restore@file:../path/to/alpine-astro-components/packages/spa-restore
```

After editing package source, rebuild before the consumer picks up changes:

```bash
bun run --cwd packages/spa-restore build
```
