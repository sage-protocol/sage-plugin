// Scroll OpenCode plugin: capture + suggest combined
//
// Uses the documented OpenCode plugin event handler pattern.
// Spawns scroll commands via the `$` shell helper for portability.

export const ScrollPlugin = async ({ client, $, directory }) => {
	const CONFIG = {
		scrollBin: process.env.SCROLL_BIN || "scroll",
		suggestLimit: Number.parseInt(process.env.SCROLL_SUGGEST_LIMIT || "3", 10),
		debounceMs: Number.parseInt(
			process.env.SCROLL_SUGGEST_DEBOUNCE_MS || "800",
			10,
		),
		provision: (process.env.SCROLL_SUGGEST_PROVISION || "1") === "1",
		dryRun: (process.env.SCROLL_PLUGIN_DRY_RUN || "0") === "1",
	};

	let promptCaptured = false;
	let lastInput = "";
	let lastInjected = "";
	let timer = null;
	let runId = 0;

	const log = async (level, message, extra = {}) => {
		try {
			if (client?.app?.log) {
				await client.app.log({
					service: "scroll-plugin",
					level,
					message,
					extra,
				});
			} else {
				console.log(`[scroll-plugin:${level}]`, message, extra);
			}
		} catch {
			/* logging should never break the plugin */
		}
	};

	const execScroll = async (args, env = {}) => {
		if (CONFIG.dryRun) return "";

		const scrollEnv = { ...env, SCROLL_SOURCE: "opencode" };

		try {
			if ($) {
				// Use OpenCode's $ shell helper for portability
				const cmd = [CONFIG.scrollBin, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
				const result = await $({ env: scrollEnv })`${cmd}`;
				return (result?.stdout ?? result ?? "").toString().trim();
			}
			// Fallback to Bun.spawn if $ not available
			if (typeof Bun !== "undefined") {
				const proc = Bun.spawn([CONFIG.scrollBin, ...args], {
					env: { ...process.env, ...scrollEnv },
					stdout: "pipe",
					stderr: "pipe",
				});
				const stdout = await new Response(proc.stdout).text();
				return stdout.trim();
			}
			return "";
		} catch (e) {
			throw new Error(`scroll command failed: ${e.message || e}`);
		}
	};

	const scheduleSuggest = (text) => {
		lastInput = text;
		runId += 1;
		const current = runId;

		if (timer) clearTimeout(timer);

		timer = setTimeout(() => {
			void (async () => {
				const prompt = lastInput.trim();
				if (!prompt) return;
				if (current !== runId) return;
				if (prompt === lastInjected) return;

				await log("debug", "running scroll suggest", {
					cwd: directory,
					prompt_len: prompt.length,
				});

				try {
					const args = [
						"suggest",
						"skill",
						prompt,
						"--limit",
						CONFIG.suggestLimit.toString(),
					];
					if (CONFIG.provision) args.push("--provision");

					const suggestions = await execScroll(args);
					if (!suggestions) return;
					if (current !== runId) return;

					lastInjected = prompt;
					await client.tui.appendPrompt({
						body: { text: `\n\n${suggestions}\n` },
					});
				} catch (e) {
					await log("warn", "scroll suggest failed", { error: String(e) });
				}
			})();
		}, CONFIG.debounceMs);
	};

	return {
		event: async ({ event }) => {
			const { type: eventType, properties } = event;

			switch (eventType) {
				case "message.part.updated": {
					const role = properties?.role;
					const content = properties?.content ?? "";

					if (role === "user" && content?.trim() && !promptCaptured) {
						promptCaptured = true;
						try {
							await execScroll(["capture", "hook", "prompt"], { PROMPT: content });
						} catch (e) {
							await log("warn", "capture prompt failed", { error: String(e) });
							promptCaptured = false;
						}
					}
					break;
				}

				case "message.updated": {
					const role = properties?.role;
					const content = properties?.content ?? "";

					if (role === "assistant" && content?.trim() && promptCaptured) {
						try {
							await execScroll(["capture", "hook", "response"], {
								CLAUDE_RESPONSE: content,
							});
						} catch (e) {
							await log("warn", "capture response failed", { error: String(e) });
						}
						promptCaptured = false;
					}
					break;
				}

				case "session.created": {
					await log("info", "session created", {
						sessionId: properties?.session?.id ?? "unknown",
						isSubagent: properties?.session?.parentId != null,
						cwd: directory,
					});
					break;
				}

				case "tui.prompt.append": {
					const text = properties?.text ?? "";
					if (text.trim()) {
						scheduleSuggest(text);
					}
					break;
				}
			}
		},
	};
};

export default ScrollPlugin;
