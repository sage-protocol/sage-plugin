# Sage Plugin for OpenCode

OpenCode plugin for Sage Protocol.

This plugin connects OpenCode sessions to the local `sage` CLI. It captures
prompt/response pairs for local learning, surfaces Sage skill and prompt
suggestions while you work, and records whether suggestions were accepted,
steered, or ignored. Sage starts as prompt and skill utility for agents; when a
workflow becomes useful, the broader protocol can route it into libraries,
private sync, marketplace sales, DAO governance, tips, bounties, reflections,
and Base L2 provenance.

## What It Does

| Surface | What the plugin provides |
| --- | --- |
| Capture | Sends prompts and assistant responses to `sage capture hook prompt|response` |
| Suggestions | Debounces OpenCode TUI prompts and runs `sage suggest skill` |
| RLM feedback | Correlates later user prompts with shown suggestions for accept/steer/reject signals |
| Session context | Tracks OpenCode session, model, tokens, cost, and workspace metadata |
| MCP setup | Works with the Sage MCP server configured by `sage init --opencode` |

The plugin is intentionally small. The judgment-heavy behavior lives in Sage
skills, prompts, libraries, and the local Sage daemon/MCP runtime.

## Get Started

Install the Sage CLI first:

```bash
npm install -g @sage-protocol/cli
sage --version
```

Initialize Sage for OpenCode inside the project where your agent will work:

```bash
sage init --opencode
sage doctor --include-details
```

This configures the Sage MCP server, installs the OpenCode plugin entry, and
syncs the companion Sage skills.

That integrated path combines two layers: this package's OpenCode plugin behavior and the bundled Sage base skill layer installed by `sage init`. The base entry layer uses Sage's shared product-story renderer so generic, Codex, Pi, and onboarding variants stay aligned.

Raw plugin install is also supported:

```bash
opencode plugin @sage-protocol/sage-plugin --global
```

OpenCode writes plugin config to `~/.config/opencode/opencode.jsonc` for global
installs. For project-local config, add the plugin and Sage MCP server to your
OpenCode config:

```json
{
  "plugin": ["@sage-protocol/sage-plugin"],
  "mcp": {
    "sage": {
      "type": "local",
      "command": ["sage", "mcp", "start"],
      "enabled": true
    }
  }
}
```

## Use It

The plugin works in the background once OpenCode loads it:

- User prompts are captured for local RLM/capture analysis.
- Assistant responses are captured with model and token metadata when available.
- TUI prompt text can trigger `sage suggest skill` suggestions.
- Suggestion feedback is captured when a later prompt overlaps with, steers, or rejects a suggestion.

Start with local utility. Connect wallets, publish libraries, list marketplace
content, tip, vote, or create bounties only when the next task actually needs
authority or value transfer.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `SAGE_BIN` | `sage` | Path to the Sage CLI binary |
| `SAGE_TIMEOUT_MS` | `20000` | Timeout for spawned Sage commands |
| `SAGE_SUGGEST_LIMIT` | `3` | Max suggestions per request |
| `SAGE_SUGGEST_DEBOUNCE_MS` | `800` | Debounce delay for TUI suggestions |
| `SAGE_SUGGEST_PROVISION` | `1` | Set `0` to skip MCP provisioning during suggestions |
| `SAGE_RLM_FEEDBACK` | `1` | Set `0` to disable suggestion feedback tracking |
| `SAGE_PLUGIN_DRY_RUN` | `0` | Set `1` to avoid spawning Sage commands in tests |

The plugin passes user prompts through `PROMPT` and assistant responses through
`SAGE_RESPONSE` when invoking Sage capture hooks.

## Verify

```bash
opencode debug config
sage mcp start
sage capture status
```

If the plugin installs but does not suggest skills, verify `sage mcp start`
works in the same shell. If capture hooks do not run, check that
`SAGE_PLUGIN_DRY_RUN` is unset and that `sage capture hook prompt` works
manually.

## Sage CLI Quick Reference

Use these commands from the same shell that launches OpenCode:

| Goal | Command |
| --- | --- |
| Runtime health | `sage doctor --include-details` |
| OpenCode setup | `sage init --opencode` |
| Start MCP manually | `sage mcp start` |
| Search skills | `sage search "<query>" --search-type skills --scope both --limit 20` |
| Suggest a skill | `sage suggest skill "<prompt>" --limit 3` |
| Capture status | `sage capture status` |
| Learned patterns | `sage metrics list-patterns --limit 20` |
| Create local library | `sage library create "my-workflow"` |
| Use local library | `sage library use "my-workflow"` |
| Push private cloud library | `sage library push "my-workflow" --cloud` |

Run `sage <command> --help` before editing docs or automating a flow. Sage CLI
surfaces can move, and plugin docs should match the installed binary.

## Distribution Surfaces

Sage has several sharing surfaces. Pick the smallest one that matches the
operator's intent:

- Local install/expose makes a prompt, skill, or library usable on this machine.
- P2P and shared libraries sync with trusted collaborators without public discovery.
- Personal cloud hosts a creator-controlled library and stays private by default.
- Marketplace publishing is for polished public artifacts the author wants to sell or distribute broadly.
- DAO promotion is for long-term public canon with governance provenance.
- Tips, bounties, reflections, and rewards are value-network actions; use them only after explicit user intent.

Never treat install, sync, save, or use as permission to publish, sell, vote,
tip, claim, or promote.

This README is self-contained for package consumers. It does not require access
to the Sage monorepo docs.

## Requirements

- Sage CLI on `PATH`, or `SAGE_BIN` set
- OpenCode
- Bun v1.3+ for development and tests

## Development

```bash
bun install
bun run lint
bun run test
```

Additional checks:

```bash
bun run test:integration   # requires a built sage binary or SAGE_BIN
bun run test:e2e           # requires daemon/MCP support from sage
```

## License

MIT
