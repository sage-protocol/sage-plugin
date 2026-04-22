# Setup

## Requirements

- OpenCode CLI (`opencode`)
- Sage CLI on `PATH`
- Bun 1.3+

## Install Modes

### Integrated Product Setup

```bash
sage init --opencode
```

This configures the Sage MCP server, installs the plugin, and syncs the companion Sage skills. For the bundled base `sage` entry layer installed by `sage init`, shared conceptual sections now come from `packages/sage/crates/cli/src/commands/skills/entry_shared.rs` plus `packages/sage/crates/cli/src/commands/skills/data/shared/`, while OpenCode-specific plugin behavior stays in this package.

### Raw Plugin Install

```bash
opencode plugin @sage-protocol/sage-plugin --global
```

This writes the package reference into `~/.config/opencode/opencode.jsonc`.

### Project-Local Config

Add the package name to your project `opencode.json`:

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

## Verify

```bash
opencode debug config
```

Confirm the plugin entry exists in the resolved config and that your Sage MCP server is configured.

## Troubleshooting

- If the plugin installs but does not suggest skills, verify `sage mcp start` works in the same shell.
- If capture hooks do not run, verify `SAGE_PLUGIN_DRY_RUN` is unset and `sage capture hook prompt` works manually.
- If OpenCode loads no external plugins, check `~/.config/opencode/opencode.jsonc` or project `opencode.json` for the `plugin` array.
