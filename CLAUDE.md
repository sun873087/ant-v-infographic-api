# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kroki-style HTTP service that wraps `@antv/infographic/ssr` and serves SVG/PNG. Designed for **internal/on-prem deployment** — see README's "為什麼造這個" section for the product motivation.

The non-obvious thing: this is essentially a thin Fastify shell wrapping a third-party SSR renderer (`@antv/infographic` 0.2.x). Most of the complexity comes from working around quirks in that upstream library and from the security model needed to deploy it in an internal-only environment.

## Commands

**Make is the canonical entry point** — `make help` lists everything. Common loops:

```bash
make install              # npm install
make docker-up            # build image + start API + redis + iconify + browserless
make test                 # vitest (cache unit + client integration)
make test-clients         # just integration tests against running server
make smoke                # quick check against running API
make demos                # render 6 complex examples via all 3 client languages
make clean                # rm dist/ + test outputs
make docker-down deps-down  # tear down

# Run a single vitest file directly
npx vitest run test/cache.test.ts
npx vitest run test/clients.test.ts -t "curl demos"  # filter by test name
```

`make demos` exercises all 6 templates × {SVG, PNG} × {curl, python, typescript} — useful as a regression check after touching renderer or routes.

## Architecture (big picture)

```
                          ┌─ Redis (cache, SHA256(syntax) → SVG)
                          ├─ Iconify Server (icons)
Fastify API ──────────────┤
(src/server.ts)           ├─ browserless / remote Chromium (PNG)
                          └─ OTel collector (optional)
```

Render pipeline:
1. `routes.ts` accepts syntax → look up `cache.ts` → MISS → call `renderer.render()` → cache result.
2. `renderer.ts` lazy-imports `@antv/infographic/ssr` (SSR is heavy, isolated for testability), runs `renderToString`.
3. For PNG: take the cached SVG, send to remote Chromium via `playwright.chromium.connect(BROWSER_WS_ENDPOINT)`, screenshot the `<svg>` element. **PNG is NOT cached** — converted on demand.

Two cross-cutting concerns wired at startup (in this order — order matters):

- `src/fetch-firewall.ts` — monkey-patches `globalThis.fetch` with an allow-list from `ALLOWED_FETCH_HOSTS`. **Must be the first import in `server.ts`** so it sees fetch before any other module does.
- `src/telemetry.ts` — OTel init. Second import. Side-effect only.

Then `bootstrap()` constructs `SvgCache`, `Renderer`, registers routes (which import `@fastify/swagger` UI at `/docs`).

## Security model (non-obvious — read this before touching renderer)

`@antv/infographic` 0.2.x has two paths that bypass our custom resource loader and reach the public CDN (`weavefox.cn`):
1. **search loader fallback**: when our custom loader returns `null`, upstream silently falls back to `loadSearchResource(...)` which hits `weavefox.cn` (hard-coded constant in `node_modules/@antv/infographic/esm/constants/service.js`).
2. **`ref:remote:` / `ref:search:` syntax**: parses to `source: 'remote'` / `'search'` in upstream and skips custom loader entirely.

Two layers of defense, both required:
1. `Renderer.buildResourceLoader` in `src/renderer.ts` **must always return a `loadSVGResource(...)` result** — never `null`. We return a placeholder `<svg>` on failure. Returning `null` triggers upstream's weavefox fallback.
2. `fetch-firewall.ts` allow-list catches anything that does try to leave Node. Production **must** set `ALLOWED_FETCH_HOSTS` to only internal hosts.

For Chromium-side fetches (Web Fonts, images inside the SVG), `renderer.renderPng` installs `page.route('**/*', ...)` with the same allow-list — separate from the Node fetch firewall because they're different network stacks.

## Gotchas earned the hard way

- **`registerResourceLoader` only lives on `@antv/infographic` main package, NOT on `@antv/infographic/ssr`**. `loadSVGResource` ditto. `renderToString` is only on `/ssr`. Import accordingly.
- **`<foreignObject>` is everywhere in upstream SVG output** for label/desc. Plain SVG-only renderers (resvg-js) drop them silently → PNG has no text. That's why we use Chromium.
- **Playwright client must match browserless server EXACTLY**. Currently both 1.59. Upgrade browserless image → bump `playwright` in `package.json` in lockstep. Mismatch = `WebSocket 428 Precondition Required`.
- **Browserless v2 idle session ~30s, then disconnect**. `Renderer.getBrowser()` uses `isConnected()` + `'disconnected'` event listener to reconnect lazily. Don't cache the `Browser` handle without that check.
- **Vitest sets `process.env.BASE_URL = '/'`** (Vite's `base` config default). Don't use `BASE_URL` as an env var name in tests — use `INFOGRAPHIC_API_URL` or similar. See `test/clients.test.ts`.
- **Fastify's `maxParamLength` defaults to 100 chars**. base64url syntax exceeds it → 404 before route handler runs. We set 8192 in `server.ts`. Bump if `MAX_SYNTAX_BYTES` grows.
- **Ajv strict mode rejects OpenAPI `example` keyword** (singular). In Swagger schemas use `examples: [...]` (array, JSON Schema 2020-12 form).
- **Project is ESM** (`"type": "module"`). `__dirname` doesn't exist — use `dirname(fileURLToPath(import.meta.url))` in test/script files.
- **`pino-pretty` only used in non-production**. `NODE_ENV=production` skips it; dev requires it as devDep.
- **`k8s/kustomization.yaml` references `iconify-server.yaml`** but the file is not in the repo. Same for `.npmrc` (Dockerfile copies it conditionally via glob — `certs/.gitkeep` keeps the dir present). These are intentional placeholders for the deployer to fill in.

## Test layout

- `test/cache.test.ts` — pure unit (no server needed).
- `test/clients.test.ts` — integration. Spawns 3 client subprocesses, asserts subprocess exit code + output files. Skips (passes) gracefully if `INFOGRAPHIC_API_URL` (default `http://localhost:3000`) isn't reachable, or if `bash`/`python3`/`jq`/`npx` missing — important for CI without all toolchains.
- `test/clients/` — 3 simple clients (`curl.sh`, `client.py`, `client.ts`) and 3 complex/demo clients (`demos.sh`, `demos.py`, `demos.ts`).
- `test/clients/demos/*.txt` — **single source of truth** for the 6 complex example syntaxes; all 3 demo clients read these files. Don't duplicate syntax into the clients.
- `test/clients/output/` — gitignored. Each client writes to its own subdir (`curl/`, `python/`, `ts/`, `complex-curl/`, etc.) so all 6 tests can run in parallel without colliding.

## Infographic syntax data fields

The `data` block in syntax accepts a fixed set of top-level fields, determined by template (from `node_modules/@antv/infographic/src/syntax/schema.ts` `DataSchema`):

- `items` / `lists` / `sequences` — flat list templates (`list-row-*`, `sequence-*`, `list-grid-*`)
- `compares` + nested `children` — comparison templates (`compare-*`, includes SWOT and hierarchy mindmaps)
- `nodes` + `relations` — network/graph templates (`relation-network-*`, `relation-circle-*`)
- `root` — tree templates
- `values` — chart templates

Using the wrong field (e.g. `columns` for SWOT) results in **SSR render timeout** (HTTP 500 after 10s), not a syntax error — symptoms look identical to upstream hang. Check `DataSchema` when in doubt.
