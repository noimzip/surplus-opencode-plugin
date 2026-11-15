# Surplus OpenCode Plugin

OpenCode V2 plugin for Surplus Intelligence. It adds a sidebar view with:

- settled Surplus cost for the current session
- realized discount versus direct-provider cost
- live best eligible offer for every configured `surplus` model
- input/output price per 1M tokens
- estimated input/output Mtok available from the current Surplus balance
- configurable sorting and display fields from the command palette

The plugin does not store API keys. It uses the authorization header from the
active Surplus request for account-scoped lookups, or `SURPLUS_API_KEY` when
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

- `Surplus: 並び順を変更`
- `Surplus: 表示項目を変更`

Display preferences are persisted by OpenCode plugin storage.

## Development

```bash
node surplus-cost.test.mjs
```

The test suite uses mocked responses and does not make paid inference calls.

## Notes

- Market data is refreshed approximately every 60 seconds.
- The best displayed offer is the best currently available and healthy offer
  by live discount. Actual request routing also considers estimated total
  request cost, health, trust policy, and failover.
- If balance or market data is unavailable, the plugin displays `不明`/`?`
  rather than treating the value as zero.
- Surplus request IDs and settled charges are stored in OpenCode plugin
  storage so streamed requests can be reconciled after completion.
