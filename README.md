# Sage Plugin (OpenCode)

OpenCode plugin for Sage Protocol. Captures prompt/response pairs for RLM feedback and provides inline skill suggestions during coding sessions.

## What It Does

- **Prompt Capture** - Silently records prompt/response pairs with session metadata (model, tokens, cost)
- **Inline Suggestions** - Debounced skill and prompt suggestions injected into the OpenCode TUI
- **RLM Feedback** - Tracks whether suggestions were accepted, steered, or rejected within a 30-second correlation window
- **Session Tracking** - Maintains session and model context across streaming responses

## Install

```bash
mkdir -p ~/.config/opencode/plugin/@sage-protocol
cp -r sage-plugin ~/.config/opencode/plugin/@sage-protocol/
```

Add the plugin to your `opencode.json`:

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

Or run `sage init --opencode` to configure automatically.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SAGE_BIN` | `sage` | Path to the sage binary |
| `SAGE_SUGGEST_LIMIT` | `3` | Max suggestions per request |
| `SAGE_SUGGEST_DEBOUNCE_MS` | `800` | Debounce delay for TUI suggestions |
| `SAGE_SUGGEST_PROVISION` | `1` | Set `0` to skip MCP provisioning |
| `SAGE_RLM_FEEDBACK` | `1` | Set `0` to disable RLM feedback tracking |
| `SAGE_PLUGIN_DRY_RUN` | `0` | Set `1` to disable spawning sage (for tests) |

## Requirements

- Sage CLI on PATH (or set `SAGE_BIN`)
- Bun v1.3+
- OpenCode

## Development

```bash
bun install
bun run lint
bun test
```

## License

MIT
