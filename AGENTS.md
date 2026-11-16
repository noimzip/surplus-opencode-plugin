# AGENTS.md

## Overview

`surplus-opencode-plugin` is an OpenCode V2 (`>=2.3.0`) plugin for [Surplus Intelligence](https://api.surplusintelligence.ai). It combines a server-side plugin and a TUI plugin to provide:

1. **Dynamic discount-floor routing**: Upgrades `/min95/v1/(chat/completions|completions|responses)` requests to `/min{floor}/` when live market depth exceeds 95% (never downgrades `/min95/`).
2. **Session cost & savings accounting**: Tracks Surplus request IDs (`x-request-id`), reconciles settled charges in microdollars, and computes realized savings against direct provider costs.
3. **Live market & balance sidebar**: Displays the best available offer per enabled `surplus` model, input/output prices per 1M tokens, and estimated affordable tokens from the current USDC credit balance.

## Repository Structure

- `package.json` — Package manifest (`type: "module"`). Defines `"test": "node surplus-cost.test.mjs"` and exports `.` (server plugin), `./tui` (TUI plugin), and `./rpc` (RPC contract).
- `plugins/surplus-cost/index.js` — Server plugin (`id: "surplus-cost"`, exported via `createSurplusCostPlugin(deps)` and default `Plugin.define(createSurplusCostPlugin())`). Registers `http.request` and `http.response` hooks for `providerID: "surplus"`, verifies `url.origin === "https://api.surplusintelligence.ai"` before capturing Bearer tokens or routing, caches per-model routing floors (20s TTL with in-flight deduplication), caches successful market lookups (60s TTL with in-flight deduplication and `refresh` bypass; skips caching when all selected model fetches fail), runs bounded concurrent settlement reconciliation (`RECONCILE_CONCURRENCY = 4`) with exponential retry backoff and bounded `direct_cost_micro` rechecks, and registers RPC handlers.
- `plugins/surplus-cost/tui.tsx` — TUI plugin (`id: "surplus-cost.tui"`). Renders the `sidebar.content` slot (polling `session` every 5s and `markets` every 60s), preserves stale data on transient RPC errors and keeps market rows across session switches, displays an `Updated` timestamp and theme-aware discount tier colors (`> 95%`, `90–95%`, `< 90%`), persists display settings under `surplus-display`, and registers command palette actions (`Surplus: Change sort order`, looping `Surplus: Change display fields`, and `Surplus: Refresh`).
- `plugins/surplus-cost/rpc.js` — `Rpc.define` contract (`id: "surplus-cost"`) declaring `session` and `markets` (`{ sessionID: string, refresh?: boolean }`) schemas shared between server and TUI.
- `plugins/surplus-cost/core.js` — Pure domain helpers: `validMicro`, `affordableMtok`, `formatUsdMicro`, `formatMtok`, `sortByVolume`, `bestDiscountFloor`, `bestOffer` (enforces `0 <= discount_pct <= 100`), `settledMicro`, and `summarize`.
- `plugins/surplus-cost/display.js` — Pure UI formatting and sorting helpers using `formatUsdMicro` and `formatMtok` from `core.js`: `defaults`, `sorts`, `fields`, `sortRows`, and `rowText`.
- `surplus-cost.test.mjs` — `node:test` suite using `node:module` `registerHooks` to virtualize `@opencode/plugin` and `@opencode/plugin/rpc`, testing `core.js`, `display.js`, `rpc.js`, `createSurplusCostPlugin` hooks/reconciliation/RPC with injected mocks, default plugin export, and `tui.tsx` TSX transpilation (via `Bun.Transpiler` when `bun` is installed).

## Development & Verification

Run the test suite with Node.js (no build step or external test runner required):

```bash
npm test
# or:
node surplus-cost.test.mjs
```

The test suite injects mocked `fetch`, `now`, and `env` via `createSurplusCostPlugin(deps)` and virtualizes `@opencode/plugin` and `@opencode/plugin/rpc` via `node:module` `registerHooks`, making no network or paid inference calls. Always run `npm test` before committing changes.

## Key Invariants & Conventions

- **Never persist credentials**: Bearer tokens captured from `http.request` `Authorization` headers (only when `url.origin === "https://api.surplusintelligence.ai"`) are stored only in memory in the `credentials` `Map` (keyed by `sessionID`) and `latestCredential`, and are cleared on plugin teardown. Never write API keys or authorization headers to `ctx.storage`. Key lookup priority is `credentials.get(sessionID) || env?.SURPLUS_API_KEY || latestCredential`.
- **Integer microdollar accounting**:
  - Surplus reports costs, prices, volumes, and balances as non-negative integer microdollars (`1 USD = 1,000,000 microdollars`), validated via `validMicro()`.
  - Never estimate or infer request charges from token prices. Only record `buyer_cost_micro` when `settlement_status` is one of `accrued`, `settled`, `confirmed`, `completed`, or `paid` (`settledMicro()`).
- **Unavailable data is never zero**:
  - Failed or missing balance, market, or settlement lookups must remain `null` / `undefined` and render as `Unknown` or `?` in the UI.
  - Failed settlement lookups in `reconcile()` must leave the record pending with exponential backoff so subsequent refreshes can retry.
- **Fail-safe request/response hooks**:
  - `http.request` must fail closed to the original `/min95/` URL on any network, timeout (3s), or parsing error, and must never downgrade `/min95/` when `floor === null || floor <= 95`.
  - `http.response` and background `reconcile()` must swallow errors so accounting never interrupts inference streaming, and `reconcile()` must check `closed` before writing to `ctx.storage`.
