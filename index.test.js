import { describe, expect, it } from "bun:test";
import ScrollPlugin from "./index.js";

describe("ScrollPlugin", () => {
	const makeClient = () => {
		const appLogCalls = [];
		const promptAppends = [];
		return {
			client: {
				app: {
					log: ({ level, message, extra }) =>
						appLogCalls.push({ level, message, extra }),
				},
				tui: { appendPrompt: ({ body }) => promptAppends.push(body?.text ?? "") },
			},
			appLogCalls,
			promptAppends,
		};
	};

	// Mock $ shell helper that records calls
	const make$ = () => {
		const calls = [];
		const shell = (opts) => {
			return (strings, ...values) => {
				const cmd = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "");
				calls.push({ cmd, env: opts?.env });
				return { stdout: "" };
			};
		};
		shell.calls = calls;
		return shell;
	};

	it("returns event handler function", async () => {
		process.env.SCROLL_PLUGIN_DRY_RUN = "1";
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		expect(typeof plugin.event).toBe("function");
		// Should NOT have old-style individual event keys
		expect(plugin["message.part.updated"]).toBeUndefined();
		expect(plugin["message.updated"]).toBeUndefined();
	});

	it("captures user prompt on message.part.updated", async () => {
		process.env.SCROLL_PLUGIN_DRY_RUN = "1";
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { role: "user", content: "hello world" },
			},
		});

		// In dry-run mode, no scroll command is executed but no error either
	});

	it("captures assistant response on message.updated", async () => {
		process.env.SCROLL_PLUGIN_DRY_RUN = "1";
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		// First capture a prompt
		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { role: "user", content: "hello" },
			},
		});

		// Then capture response
		await plugin.event({
			event: {
				type: "message.updated",
				properties: { role: "assistant", content: "hi there" },
			},
		});
	});

	it("logs session.created event", async () => {
		process.env.SCROLL_PLUGIN_DRY_RUN = "1";
		const { client, appLogCalls } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		await plugin.event({
			event: {
				type: "session.created",
				properties: { session: { id: "test-123" } },
			},
		});

		const sessionLog = appLogCalls.find((c) => c.message === "session created");
		expect(sessionLog).toBeDefined();
		expect(sessionLog.extra.sessionId).toBe("test-123");
	});

	it("schedules suggest on tui.prompt.append", async () => {
		process.env.SCROLL_PLUGIN_DRY_RUN = "1";
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		await plugin.event({
			event: {
				type: "tui.prompt.append",
				properties: { text: "build an MCP server" },
			},
		});

		// Suggest is debounced, so no immediate effect to assert
	});

	it("handles unknown events gracefully", async () => {
		process.env.SCROLL_PLUGIN_DRY_RUN = "1";
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		// Should not throw
		await plugin.event({
			event: { type: "unknown.event", properties: {} },
		});
	});
});
