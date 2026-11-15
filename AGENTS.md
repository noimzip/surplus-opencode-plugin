# AGENTS.md

## Overview

`surplus-opencode-plugin` is an OpenCode V2 (`>=2.3.0`) plugin for [Surplus Intelligence](https://api.surplusintelligence.ai). It combines a server-side plugin and a TUI plugin to provide:

1. **Dynamic discount-floor routing**: Upgrades `/min95/v1/(chat/completions|completions|responses)` requests to `/min{floor}/` based on live market depth.
2. **Session cost & savings accounting**: Tracks Surplus request IDs (`x-request-id`), reconciles settled charges in microdollars, and computes realized savings against direct provider costs.
3. **Live market & balance sidebar**: Displays the best available offer per enabled `surplus` model, input/output prices per 1M tokens, and estimated affordable tokens from the current USDC credit balance.

## Repository Structure

- `package.json` — Package manifest (`type: "module"`). Exports `.` (server plugin), `./tui` (TUI plugin), and `./rpc` (RPC contract).
- `plugins/surplus-cost/index.js` — Server plugin (`id: "surplus-cost"`). Registers `http.request` and `http.response` hooks for `providerID: "surplus"`, manages in-memory session credentials, caches market lookups (60s TTL), reconciles request settlements in `ctx.storage`, and registers RPC handlers.
- `plugins/surplus-cost/tui.tsx` — TUI plugin (`id: "surplus-cost.tui"`). Renders the `sidebar.content` slot (polling `session` every 5s and `markets` every 60s), persists display settings under `surplus-display`, and registers command palette actions (`Surplus: Change sort order`, `Surplus: Change display fields`).
- `plugins/surplus-cost/rpc.js` — `Rpc.define` contract (`id: "surplus-cost"`) declaring `session` and `markets` schemas shared between server and TUI.
- `plugins/surplus-cost/core.js` — Pure domain helpers: `validMicro`, `affordableMtok`, `sortByVolume`, `bestDiscountFloor`, `bestOffer`, `settledMicro`, and `summarize`.
- `plugins/surplus-cost/display.js` — Pure UI formatting and sorting helpers: `defaults`, `sorts`, `fields`, `sortRows`, and `rowText`.
- `surplus-cost.test.mjs` — Self-contained Node.js test suite covering unit logic and hook/RPC integration with mocked `fetch`.

## Development & Verification

Run the test suite with Node.js (no build step or external test runner required):

```bash
node surplus-cost.test.mjs
```

The test suite mocks `globalThis.fetch` and `@opencode/plugin` and makes no network or paid inference calls. Always run `node surplus-cost.test.mjs` before committing changes.

## Key Invariants & Conventions

- **Never persist credentials**: Bearer tokens captured from `http.request` `Authorization` headers are stored only in the in-memory `credentials` `Map` (keyed by `sessionID`) and cleared on plugin teardown. Never write API keys or authorization headers to `ctx.storage`. Fallback authentication uses `process.env.SURPLUS_API_KEY`.
- **Integer microdollar accounting**:
  - Surplus reports costs, prices, volumes, and balances as non-negative integer microdollars (`1 USD = 1,000,000 microdollars`), validated via `validMicro()`.
  - Never estimate or infer request charges from token prices. Only record `buyer_cost_micro` when `settlement_status` is one of `accrued`, `settled`, `confirmed`, `completed`, or `paid` (`settledMicro()`).
- **Unavailable data is never zero**:
  - Failed or missing balance, market, or settlement lookups must remain `null` / `undefined` and render as `Unknown` or `?` in the UI.
  - Failed settlement lookups in `reconcile()` must leave the record pending so subsequent refreshes can retry.
- **Fail-safe request/response hooks**:
  - `http.request` must fail closed to the original `/min95/` URL on any network, timeout (3s), or parsing error.
  - `http.response` and background `reconcile()` must swallow errors so accounting never interrupts inference streaming.
- **Test loader constraint**: `surplus-cost.test.mjs` loads `plugins/surplus-cost/index.js` by stripping top-level `import` lines and injecting `globalThis.__surplusTest` immediately before `const API =`. If you add or rename imports or change `const API =` in `plugins/surplus-cost/index.js`, update `surplus-cost.test.mjs` accordingly.
