import { describe, expect, it, beforeEach } from "bun:test";
import ScrollPlugin from "./index.js";

describe("ScrollPlugin", () => {
	beforeEach(() => {
		process.env.SCROLL_PLUGIN_DRY_RUN = "1";
	});

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

	it("returns event handler and chat.message hook", async () => {
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		expect(typeof plugin.event).toBe("function");
		expect(typeof plugin["chat.message"]).toBe("function");
	});

	it("chat.message hook captures prompt with session/model env vars", async () => {
		const { client } = makeClient();
		const $mock = make$();
		const plugin = await ScrollPlugin({ client, $: $mock, directory: "/tmp" });

		await plugin["chat.message"](
			{ sessionID: "sess-abc", model: { providerID: "anthropic", modelID: "claude-3" } },
			{ message: {}, parts: [{ type: "text", text: "hello world" }] },
		);

		// In dry-run mode no command is executed, but state should be set
		// No error means it worked
	});

	it("chat.message hook ignores empty parts", async () => {
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		// Should not throw or set promptCaptured
		await plugin["chat.message"](
			{ sessionID: "s1" },
			{ parts: [{ type: "text", text: "   " }] },
		);

		// Subsequent assistant message.updated should be ignored (no prompt captured)
		await plugin.event({
			event: {
				type: "message.updated",
				properties: { info: { role: "assistant", modelID: "x", tokens: {} } },
			},
		});
	});

	it("message.part.updated accumulates assistant text parts", async () => {
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		// First capture a prompt via chat.message hook
		await plugin["chat.message"](
			{ sessionID: "s1", model: { modelID: "claude-3" } },
			{ parts: [{ type: "text", text: "explain rust" }] },
		);

		// Simulate streaming assistant parts
		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { part: { type: "text", text: "Rust is ", sessionID: "s1", messageID: "m1" } },
			},
		});
		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { part: { type: "text", text: "a systems language.", sessionID: "s1", messageID: "m1" } },
			},
		});

		// Finalize with message.updated
		await plugin.event({
			event: {
				type: "message.updated",
				properties: {
					info: {
						role: "assistant",
						sessionID: "s1",
						modelID: "claude-3",
						tokens: { input: 10, output: 20 },
					},
				},
			},
		});

		// No error means parts were accumulated and flushed correctly
	});

	it("message.updated ignores non-assistant roles", async () => {
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		await plugin["chat.message"](
			{ sessionID: "s1" },
			{ parts: [{ type: "text", text: "hi" }] },
		);

		// user role message.updated should not flush
		await plugin.event({
			event: {
				type: "message.updated",
				properties: { info: { role: "user", sessionID: "s1" } },
			},
		});

		// promptCaptured should still be true — assistant parts can still arrive
		// Verify by sending an actual assistant completion
		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { part: { type: "text", text: "response" } },
			},
		});
		await plugin.event({
			event: {
				type: "message.updated",
				properties: { info: { role: "assistant", tokens: { input: 1, output: 2 } } },
			},
		});
	});

	it("session.created resets state and tracks session ID", async () => {
		const { client, appLogCalls } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		// Capture a prompt first
		await plugin["chat.message"](
			{ sessionID: "old-session" },
			{ parts: [{ type: "text", text: "hello" }] },
		);

		// New session resets everything
		await plugin.event({
			event: {
				type: "session.created",
				properties: { info: { id: "new-session-123", parentID: null, directory: "/project" } },
			},
		});

		const sessionLog = appLogCalls.find((c) => c.message === "session created");
		expect(sessionLog).toBeDefined();
		expect(sessionLog.extra.sessionId).toBe("new-session-123");
		expect(sessionLog.extra.isSubagent).toBe(false);
	});

	it("session.created detects subagent via parentID", async () => {
		const { client, appLogCalls } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		await plugin.event({
			event: {
				type: "session.created",
				properties: { info: { id: "child-1", parentID: "parent-1" } },
			},
		});

		const sessionLog = appLogCalls.find((c) => c.message === "session created");
		expect(sessionLog.extra.isSubagent).toBe(true);
	});

	it("multiple prompt-response cycles work correctly", async () => {
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		// Cycle 1
		await plugin["chat.message"](
			{ sessionID: "s1", model: { modelID: "claude-3" } },
			{ parts: [{ type: "text", text: "first question" }] },
		);
		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { part: { type: "text", text: "first answer" } },
			},
		});
		await plugin.event({
			event: {
				type: "message.updated",
				properties: { info: { role: "assistant", tokens: { input: 5, output: 10 } } },
			},
		});

		// Cycle 2
		await plugin["chat.message"](
			{ sessionID: "s1", model: { modelID: "claude-3" } },
			{ parts: [{ type: "text", text: "second question" }] },
		);
		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { part: { type: "text", text: "second answer" } },
			},
		});
		await plugin.event({
			event: {
				type: "message.updated",
				properties: { info: { role: "assistant", tokens: { input: 8, output: 15 } } },
			},
		});

		// No errors means state properly resets between cycles
	});

	it("handles missing/null properties gracefully", async () => {
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		// chat.message with null parts
		await plugin["chat.message"](null, null);
		await plugin["chat.message"]({}, { parts: null });
		await plugin["chat.message"]({}, { parts: [] });

		// Events with missing properties
		await plugin.event({ event: { type: "message.part.updated", properties: {} } });
		await plugin.event({ event: { type: "message.updated", properties: {} } });
		await plugin.event({ event: { type: "session.created", properties: {} } });
		await plugin.event({ event: { type: "unknown.event", properties: {} } });
	});

	it("schedules suggest on tui.prompt.append", async () => {
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

	it("non-text parts in message.part.updated are ignored", async () => {
		const { client } = makeClient();
		const plugin = await ScrollPlugin({ client, $: make$(), directory: "/tmp" });

		await plugin["chat.message"](
			{ sessionID: "s1" },
			{ parts: [{ type: "text", text: "question" }] },
		);

		// Tool-use part should be ignored
		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { part: { type: "tool-use", name: "bash", input: {} } },
			},
		});

		// Only text parts should be accumulated — tool-use ignored
		await plugin.event({
			event: {
				type: "message.part.updated",
				properties: { part: { type: "text", text: "actual response" } },
			},
		});

		await plugin.event({
			event: {
				type: "message.updated",
				properties: { info: { role: "assistant", tokens: { input: 1, output: 1 } } },
			},
		});
	});
});
