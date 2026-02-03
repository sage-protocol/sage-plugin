import { describe, expect, it } from "bun:test";

const TIMEOUT = 20_000;

function createMcpClient(proc) {
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
            // Ignore malformed lines (stdout should be JSON-RPC, but be resilient).
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
      // Fail any outstanding requests.
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

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeSageProcess(env = {}) {
  const sageBin = process.env.SAGE_BIN || new URL("../target/debug/sage", import.meta.url).pathname;
  return Bun.spawn([sageBin, "mcp", "start"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

async function initMcp(client) {
  const init = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "sage-plugin-test", version: "0.0.0" },
  });
  client.notify("notifications/initialized", {});
  return init;
}

describe("sage-plugin integration: CLI <-> MCP", () => {
  it(
    "sage mcp start initializes and exposes native tools",
    async () => {
      const proc = makeSageProcess();
      const client = createMcpClient(proc);

      try {
        const init = await initMcp(client);
        expect(init).toBeTruthy();

        const toolsList = await client.request("tools/list", {});
        expect(Array.isArray(toolsList?.tools)).toBe(true);
        expect(toolsList.tools.length).toBeGreaterThan(0);

        const hasProjectContext = toolsList.tools.some((t) => t.name === "get_project_context");
        expect(hasProjectContext).toBe(true);

        const callRes = await client.request("tools/call", {
          name: "get_project_context",
          arguments: {},
        });
        expect(callRes).toBeTruthy();
        expect(callRes.isError || false).toBe(false);
      } finally {
        proc.kill("SIGTERM");
      }
    },
    TIMEOUT,
  );

  it(
    "get_prompt tool schema includes vars parameter",
    async () => {
      const proc = makeSageProcess();
      const client = createMcpClient(proc);

      try {
        await initMcp(client);

        const toolsList = await client.request("tools/list", {});
        const getPrompt = toolsList.tools.find((t) => t.name === "get_prompt");
        expect(getPrompt).toBeTruthy();
        expect(getPrompt.inputSchema.properties.vars).toBeTruthy();
        expect(getPrompt.inputSchema.properties.vars.type).toBe("object");
        expect(getPrompt.description).toContain("variables");
      } finally {
        proc.kill("SIGTERM");
      }
    },
    TIMEOUT,
  );

  it(
    "get_prompt interpolates vars in behavior prompt content",
    async () => {
      // Create a temp data dir with a behavior-type library
      // sage resolves: $XDG_DATA_HOME/sage/libraries/
      const tempDir = join(tmpdir(), `sage-test-${Date.now()}`);
      const libDir = join(tempDir, "sage", "libraries");
      mkdirSync(libDir, { recursive: true });

      const manifest = {
        version: "3.0.0",
        library: {
          name: "test-behaviors",
          description: "Test behavior templates",
        },
        prompts: [
          {
            key: "viral-thread",
            name: "Viral Thread Generator",
            type: "behavior",
            category: "viral-engagement",
            tags: ["viral", "behavior"],
            content:
              "{{number}} {{adjective}} {{topic}} tips:\n\nMost people get {{common_thing}} wrong.",
            variables: [
              {
                name: "number",
                description: "How many tips",
                default: "5",
              },
              {
                name: "adjective",
                description: "Descriptor",
                default: "Essential",
              },
              {
                name: "topic",
                description: "Subject matter",
                required: true,
              },
              {
                name: "common_thing",
                default: "the basics",
              },
            ],
          },
        ],
      };

      writeFileSync(join(libDir, "test-behaviors.json"), JSON.stringify(manifest, null, 2));

      // sage resolves data_dir from $XDG_DATA_HOME/sage
      const proc = makeSageProcess({ XDG_DATA_HOME: tempDir });
      const client = createMcpClient(proc);

      try {
        await initMcp(client);

        // Call get_prompt with vars
        const callRes = await client.request("tools/call", {
          name: "get_prompt",
          arguments: {
            key: "viral-thread",
            library: "test-behaviors",
            vars: { topic: "MCP", number: "10" },
          },
        });

        expect(callRes).toBeTruthy();
        expect(callRes.isError || false).toBe(false);

        // Parse the response content
        const text = callRes.content?.map((c) => c.text ?? "").join("\n");
        const result = JSON.parse(text);

        expect(result.found).toBe(true);
        expect(result.prompt.content).toContain("10");
        expect(result.prompt.content).toContain("MCP");
        expect(result.prompt.content).toContain("Essential"); // default for adjective
        expect(result.prompt.content).toContain("the basics"); // default for common_thing
        expect(result.prompt.content).not.toContain("{{");

        // Variables metadata should be exposed
        expect(result.prompt.variables).toBeTruthy();
        expect(result.prompt.variables.length).toBe(4);
      } finally {
        proc.kill("SIGTERM");
        try {
          rmSync(tempDir, { recursive: true });
        } catch {}
      }
    },
    TIMEOUT,
  );
});
