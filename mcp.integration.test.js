import { describe, expect, it } from "bun:test";

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
							if (msg.error)
								waiter.reject(new Error(msg.error.message || "MCP error"));
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
				encoder.encode(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				),
			);
			return new Promise((resolve, reject) => {
				pending.set(String(id), { resolve, reject });
			});
		},
		notify(method, params) {
			if (closed) return;
			proc.stdin.write(
				encoder.encode(
					`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
				),
			);
		},
	};
}

describe("sage-plugin integration: CLI <-> MCP", () => {
	it("sage mcp start initializes and exposes native tools", async () => {
		const sageBin =
			process.env.SAGE_BIN ||
			new URL("../target/debug/sage", import.meta.url).pathname;
		const proc = Bun.spawn([sageBin, "mcp", "start"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		const client = createMcpClient(proc);

		try {
			const init = await client.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "sage-plugin-test", version: "0.0.0" },
			});
			expect(init).toBeTruthy();

			// MCP handshake
			client.notify("notifications/initialized", {});

			const toolsList = await client.request("tools/list", {});
			expect(Array.isArray(toolsList?.tools)).toBe(true);
			expect(toolsList.tools.length).toBeGreaterThan(0);

			const hasProjectContext = toolsList.tools.some(
				(t) => t.name === "get_project_context",
			);
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
	});
});
