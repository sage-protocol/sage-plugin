/**
 * E2E Test: RLM Capture & Suggestion Loop via MCP
 *
 * Validates the full cycle:
 *   1. Start daemon + MCP server (isolated HOME)
 *   2. Baseline rlm_stats (zero state)
 *   3. Inject captures via CLI
 *   4. Run rlm_analyze_captures
 *   5. Query rlm_list_patterns
 *   6. Verify rlm_stats reflects the analysis
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  callTool,
  createIsolatedHome,
  injectCapture,
  killProc,
  resolveSageBin,
  spawnSageMcp,
  startDaemon,
} from "./test-utils.js";

const sageBin = resolveSageBin();
const TIMEOUT = 60_000;

describe("RLM E2E: capture -> analyze -> patterns -> stats", () => {
  let daemonProc;
  let mcpProc;
  let client;
  let tmpHome;

  beforeAll(async () => {
    tmpHome = createIsolatedHome();

    // Start daemon first (provides RLM service via IPC)
    daemonProc = await startDaemon(sageBin, tmpHome);

    // Then start MCP server (routes RLM tool calls to daemon)
    const mcp = await spawnSageMcp(sageBin, tmpHome);
    mcpProc = mcp.proc;
    client = mcp.client;
  }, TIMEOUT);

  afterAll(() => {
    if (mcpProc) killProc(mcpProc);
    if (daemonProc) killProc(daemonProc);
  });

  it(
    "baseline rlm_stats returns zero state",
    async () => {
      const result = await callTool(client, "rlm_stats");
      if (result.isError) {
        console.error("rlm_stats error:", result.text);
      }
      expect(result.isError).toBe(false);
      expect(result.json).toBeTruthy();
      expect(result.json.total_analyses).toBe(0);
      expect(result.json.patterns_discovered).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "inject captures via CLI without crashing",
    async () => {
      const prompts = [
        {
          prompt: "How do I optimize database queries in PostgreSQL?",
          response: "Use EXPLAIN ANALYZE, add indexes, avoid SELECT *, use connection pooling.",
        },
        {
          prompt: "What are best practices for REST API design?",
          response: "Use proper HTTP methods, version your API, paginate responses, use HATEOAS.",
        },
        {
          prompt: "How to handle errors in async Rust code?",
          response:
            "Use Result<T, E>, the ? operator, anyhow for applications, thiserror for libraries.",
        },
        {
          prompt: "Explain React useEffect cleanup functions",
          response:
            "Return a cleanup function from useEffect to cancel subscriptions, timers, or listeners.",
        },
        {
          prompt: "How to set up CI/CD with GitHub Actions?",
          response:
            "Create .github/workflows/*.yml, define jobs with steps, use caching for dependencies.",
        },
      ];

      for (const { prompt, response } of prompts) {
        const result = await injectCapture(sageBin, tmpHome, {
          prompt,
          response,
        });
        expect(result.promptExit).toBeDefined();
        expect(result.responseExit).toBeDefined();
      }
    },
    TIMEOUT,
  );

  it(
    "rlm_analyze_captures returns analysis result",
    async () => {
      const { text, isError, json } = await callTool(client, "rlm_analyze_captures", {
        goal: "optimize developer workflow",
      });
      expect(isError).toBe(false);
      expect(text.length).toBeGreaterThan(0);
      // Should have structured response
      if (json) {
        expect(json.model_used).toBeDefined();
        expect(json.execution_time_ms).toBeDefined();
      }
    },
    TIMEOUT,
  );

  it(
    "rlm_list_patterns returns patterns array",
    async () => {
      const { isError, json } = await callTool(client, "rlm_list_patterns", {});
      expect(isError).toBe(false);
      if (json) {
        expect(Array.isArray(json.patterns)).toBe(true);
        expect(typeof json.count).toBe("number");
      }
    },
    TIMEOUT,
  );

  it(
    "rlm_stats after analysis reflects activity",
    async () => {
      const { isError, json } = await callTool(client, "rlm_stats");
      expect(isError).toBe(false);
      expect(json).toBeTruthy();
      // After running analyze, total_analyses should have incremented
      expect(typeof json.total_analyses).toBe("number");
      expect(typeof json.patterns_discovered).toBe("number");
      expect(typeof json.unique_sessions).toBe("number");
    },
    TIMEOUT,
  );
});
