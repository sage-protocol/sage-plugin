# Developer Guide

## Commands

```bash
bun install
bun run lint
bun run test
bun run test:integration
bun run test:e2e
npm pack --json
```

## Package Contract

The published package intentionally ships a small runtime surface:

- `index.js`
- `README.md`
- `CHANGELOG.md`

Tests and workflow files stay out of the npm tarball.

## Test Surface

- `index.test.js`: plugin lifecycle, capture logic, prompt correlation, session tracking
- `mcp.integration.test.js`: Sage MCP bridge handshake and tool contract coverage
- `rlm.e2e.test.js`: end-to-end RLM capture loop
- `rlm-feedback.e2e.test.js`: prompt-suggestion feedback correlation and steering detection

`bun run test` runs the unit suite only. Integration and e2e suites are split into dedicated commands because they require a built `sage` binary and daemon/MCP runtime support.

## CI Contract

CI runs two validation passes:

1. `lint-and-test`
   - `bun install`
   - `bun run lint`
   - `bun test`

2. `latest-opencode-install-check`
   - `npm pack --json`
   - install the tarball with `npx opencode-ai plugin <tarball> --global`
   - verify the isolated OpenCode config file references the tarball
   - verify `opencode debug config` succeeds

## Notes

- The OpenCode runtime path in CI uses `opencode-ai`, which provides the `opencode` CLI.
- If the package surface changes, update the tarball assertions and README install instructions together.
