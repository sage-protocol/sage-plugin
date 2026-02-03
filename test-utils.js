/**
 * Shared test utilities for sage-plugin E2E tests.
 *
 * Provides helpers for spawning an isolated sage daemon + MCP process,
 * communicating via JSON-RPC, and injecting captures.
 */

import { mkdtempSync, existsSync } from "node:fs";

/** Resolve the sage binary path. */
export function resolveSageBin() {
  return process.env.SAGE_BIN || new URL("../target/debug/sage", import.meta.url).pathname;
}

/**
 * Create an MCP JSON-RPC client over a Bun subprocess stdio.
 */
export function createMcpClient(proc) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending = new Map();

  let closed = false;
  let closeErr;
  let buf = "";

  (async () => {
    try {
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk);
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }

          if (msg && msg.id != null) {
            const key = String(msg.id);
            const waiter = pending.get(key);
            if (waiter) {
              pending.delete(key);
              if (msg.error) waiter.reject(new Error(msg.error.message || "MCP error"));
              else waiter.resolve(msg.result);
            }
          }
        }
      }
      closed = true;
    } catch (e) {
      closed = true;
      closeErr = e;
    } finally {
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      for (const { reject } of pending.values()) {
        reject(
          new Error(
            `MCP process ended before response. stderr:\n${stderr || "<empty>"}${closeErr ? `\nstdout reader error: ${closeErr}` : ""}`,
          ),
        );
      }
      pending.clear();
    }
  })();

  return {
    request(method, params) {
      if (closed) {
        throw new Error("MCP client is closed");
      }
      const id = `${Date.now()}-${Math.random()}`;
      proc.stdin.write(
        encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`),
      );
      return new Promise((resolve, reject) => {
        pending.set(String(id), { resolve, reject });
      });
    },
    notify(method, params) {
      if (closed) return;
      proc.stdin.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`));
    },
  };
}

/**
 * Create a temporary isolated HOME directory for test isolation.
 *
 * Uses a short path under /tmp to avoid exceeding Unix socket path limits
 * (SUN_LEN is typically 104 bytes on macOS, 108 on Linux).
 * The sage daemon socket goes under $HOME/.sage/run/ or XDG_RUNTIME_DIR.
 */
export function createIsolatedHome() {
  // Short prefix to keep socket paths under SUN_LEN
  return mkdtempSync("/tmp/se-");
}

/**
 * Build an env object that isolates sage state to a temp directory.
 */
export function isolatedEnv(tmpHome) {
  return {
    ...process.env,
    HOME: tmpHome,
    XDG_CONFIG_HOME: `${tmpHome}/c`,
    XDG_DATA_HOME: `${tmpHome}/d`,
    XDG_RUNTIME_DIR: `${tmpHome}/r`,
    SAGE_HOME: `${tmpHome}/.sage`,
  };
}

/**
 * Start the sage daemon in foreground mode.
 * Returns the daemon process. The daemon is ready when IPC socket appears.
 */
export async function startDaemon(sageBin, tmpHome) {
  const env = isolatedEnv(tmpHome);

  const daemonProc = Bun.spawn([sageBin, "daemon", "start", "-f"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Wait for daemon to be ready (socket file appears)
  // The daemon creates a socket at ~/.sage/run/sage.sock or under XDG_RUNTIME_DIR
  const maxWait = 15_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    // Check if daemon is still alive
    if (daemonProc.exitCode !== null) {
      const stderr = await new Response(daemonProc.stderr).text().catch(() => "");
      throw new Error(`Daemon exited early (code ${daemonProc.exitCode}): ${stderr}`);
    }

    // Try to detect readiness via socket file
    const candidates = [
      `${tmpHome}/r/sage/sage.sock`,
      `${tmpHome}/r/sage.sock`,
      `${tmpHome}/.sage/run/sage.sock`,
      `${tmpHome}/.sage/sage.sock`,
    ];
    if (candidates.some((p) => existsSync(p))) {
      break;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  // Give daemon a moment to finish initializing after socket appears
  await new Promise((r) => setTimeout(r, 500));

  return daemonProc;
}

/**
 * Spawn `sage mcp start` with isolated HOME and return { proc, client }.
 * Performs MCP handshake (initialize + initialized notification).
 *
 * NOTE: A daemon must already be running for RLM tools to work.
 */
export async function spawnSageMcp(sageBin, tmpHome) {
  const env = isolatedEnv(tmpHome);

  const proc = Bun.spawn([sageBin, "mcp", "start"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const client = createMcpClient(proc);

  // MCP handshake
  const init = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "sage-e2e-test", version: "0.0.0" },
  });
  client.notify("notifications/initialized", {});

  return { proc, client, env, init };
}

/**
 * Call an MCP tool by name and return the result.
 *
 * Returns { raw, text, json, isError } where:
 * - raw: the full MCP result object
 * - text: concatenated text content
 * - json: parsed JSON if text is valid JSON, otherwise null
 * - isError: whether the MCP response flagged an error
 */
export async function callTool(client, name, args = {}) {
  const result = await client.request("tools/call", {
    name,
    arguments: args,
  });

  const text =
    result?.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n") ?? "";

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }

  return { raw: result, text, json, isError: result?.isError ?? false };
}

/**
 * Inject a capture (prompt + response) via the sage CLI.
 * Uses `sage capture hook prompt` and `sage capture hook response` subcommands.
 */
export async function injectCapture(
  sageBin,
  tmpHome,
  {
    prompt = "test prompt",
    response = "test response",
    sessionId = "e2e-session",
    model = "test-model",
    source = "e2e-test",
    tokensInput = "100",
    tokensOutput = "50",
  } = {},
) {
  const env = isolatedEnv(tmpHome);

  // Phase 1: capture prompt
  const promptProc = Bun.spawn([sageBin, "capture", "hook", "prompt"], {
    env: {
      ...env,
      SAGE_SOURCE: source,
      PROMPT: prompt,
      SAGE_SESSION_ID: sessionId,
      SAGE_MODEL: model,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await promptProc.exited;

  // Phase 2: capture response
  const responseProc = Bun.spawn([sageBin, "capture", "hook", "response"], {
    env: {
      ...env,
      SAGE_SOURCE: source,
      LAST_RESPONSE: response,
      TOKENS_INPUT: tokensInput,
      TOKENS_OUTPUT: tokensOutput,
      SAGE_SESSION_ID: sessionId,
      SAGE_MODEL: model,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await responseProc.exited;

  return {
    promptExit: promptProc.exitCode,
    responseExit: responseProc.exitCode,
  };
}

/**
 * Kill a process safely.
 */
export function killProc(proc) {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}
