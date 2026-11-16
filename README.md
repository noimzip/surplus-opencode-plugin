# Surplus OpenCode Plugin

OpenCode V2 plugin for Surplus Intelligence. It adds a sidebar view with:

- settled Surplus cost for the current session
- realized discount versus direct-provider cost
- live best eligible offer for every configured `surplus` model
- input/output price per 1M tokens
- estimated input/output Mtok available from the current Surplus balance
- configurable sorting and display fields from the command palette

The plugin does not persist API keys. It uses the Bearer token from active
`https://api.surplusintelligence.ai` requests (with an in-memory cross-session
fallback within the running server process), or `SURPLUS_API_KEY` when
available to the OpenCode server.

## Install from a clone

Clone this repository, then add the plugin directory to your OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/home/you/src/surplus-opencode-plugin/plugins/surplus-cost"
  ]
}
```

Use an absolute path or a path relative to the config file. Reload OpenCode
with `/reload` after changing the config.

The plugin expects a provider with ID `surplus` and an OpenAI-compatible
Surplus endpoint. It discovers the enabled models from OpenCode's resolved
model catalog, so the sidebar follows the models configured there.

## Commands

Open the command palette and use:

- `Surplus: Change sort order`
- `Surplus: Change display fields` (stays open across toggles until canceled)
- `Surplus: Refresh` (immediately refreshes session cost and bypasses the server market cache)

Display preferences are persisted by OpenCode plugin storage.

## Development

```bash
npm test
# or:
node surplus-cost.test.mjs
```

The test suite uses mocked responses and does not make paid inference calls.

## Notes

- Requests targeting `/min95/` are upgraded to `/min{floor}/` only when the
  live best discount floor exceeds 95%; `/min95/` is never downgraded.
- Market data is refreshed automatically approximately every 60 seconds (or on
  demand with `Surplus: Refresh`). The sidebar shows an `Updated` timestamp and
  preserves previously loaded data marked as stale on transient refresh errors.
- The best displayed offer is the best currently available and healthy offer
  by live discount. Actual request routing also considers estimated total
  request cost, health, trust policy, and failover.
- If balance or market data is unavailable, the plugin displays `Unknown`/`?`
  rather than treating the value as zero.
- Surplus request IDs and settled charges are stored in OpenCode plugin
  storage so streamed requests can be reconciled after completion.
