# Sage Plugin (OpenCode)

Unified OpenCode plugin for Sage that handles both prompt capture (for RLM feedback) and inline skill/prompt suggestions.

## Requirements
- Bun runtime (tested with 1.3+)
- `sage` CLI available in PATH (or set `SAGE_BIN`)

## Setup
1. Copy the plugin into OpenCode plugins (scoped name retained):
   ```bash
   mkdir -p ~/.config/opencode/plugin
   mkdir -p ~/.config/opencode/plugin/@sage-protocol
   cp -r sage-plugin ~/.config/opencode/plugin/@sage-protocol/
   ```
2. Ensure `opencode.json` includes the plugin:
   ```json
   {
     "plugin": ["@sage-protocol/sage-plugin"],
     "mcp": { "sage": { "type": "local", "command": ["sage", "mcp", "start"], "enabled": true } }
   }
   ```
   (running `sage init --opencode` will add this automatically.)

## Environment
- `SAGE_BIN`: override sage binary path
- `SAGE_SUGGEST_LIMIT`: suggestions per request (default 3)
- `SAGE_SUGGEST_DEBOUNCE_MS`: debounce for TUI suggestions (default 800ms)
- `SAGE_SUGGEST_PROVISION`: set `0` to skip MCP provisioning
- `SAGE_PLUGIN_DRY_RUN`: set `1` to disable spawning sage (useful for tests)

## Dev
```bash
bun install
bun run lint
bun test
```
