# Scroll Plugin (OpenCode)

Unified OpenCode plugin for Scroll that handles both prompt capture (for RLM feedback) and inline skill/prompt suggestions.

## Requirements
- Bun runtime (tested with 1.3+)
- `scroll` CLI available in PATH (or set `SCROLL_BIN`)

## Setup
1. Copy the plugin into OpenCode plugins (scoped name retained):
   ```bash
   mkdir -p ~/.config/opencode/plugin
   mkdir -p ~/.config/opencode/plugin/@sage-protocol
   cp -r scroll-plugin ~/.config/opencode/plugin/@sage-protocol/
   ```
2. Ensure `opencode.json` includes the plugin:
   ```json
   {
     "plugin": ["@sage-protocol/scroll-plugin"],
     "mcp": { "scroll": { "type": "local", "command": ["scroll", "mcp", "start"], "enabled": true } }
   }
   ```
   (running `scroll init --opencode` will add this automatically.)

## Environment
- `SCROLL_BIN`: override scroll binary path
- `SCROLL_SUGGEST_LIMIT`: suggestions per request (default 3)
- `SCROLL_SUGGEST_DEBOUNCE_MS`: debounce for TUI suggestions (default 800ms)
- `SCROLL_SUGGEST_PROVISION`: set `0` to skip MCP provisioning
- `SCROLL_PLUGIN_DRY_RUN`: set `1` to disable spawning scroll (useful for tests)

## Dev
```bash
bun install
bun run lint
bun test
```
