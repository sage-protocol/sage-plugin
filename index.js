// Scroll OpenCode plugin: capture + suggest + RLM feedback combined
//
// Uses the documented OpenCode plugin event handler pattern.
// Spawns scroll commands via the `$` shell helper for portability.
// Now includes RLM feedback appending when steering is detected.

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
		enableRlmFeedback: (process.env.SCROLL_RLM_FEEDBACK || "1") === "1",
	};

	let promptCaptured = false;
	let lastInput = "";
	let lastInjected = "";
	let timer = null;
	let runId = 0;

	// Session/model tracking (populated by chat.message hook or session.created event)
	let currentSessionId = null;
	let currentModel = null;
	let assistantParts = []; // accumulate streaming text parts

	// RLM Feedback tracking
	let lastSuggestion = null;
	let lastSuggestionTimestamp = null;
	let lastSuggestionPromptKey = null;
	const SUGGESTION_CORRELATION_WINDOW_MS = 30000; // 30 second window

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
	
	// Parse suggestion output to extract prompt key
	const parseSuggestionKey = (suggestionText) => {
		// Look for patterns like "ultrawork-parallel-orchestration" or similar keys
		// Format is typically: prompt_name (key: actual-key)
		const keyMatch = suggestionText.match(/\(key:\s*([^)]+)\)/);
		if (keyMatch) {
			return keyMatch[1].trim();
		}
		
		// Try to match standalone keys in the text
		const lines = suggestionText.split('\n');
		for (const line of lines) {
			// Look for common prompt key patterns
			const match = line.match(/^\s*[-•*]?\s*([a-z0-9-]+)(?:\s*[-:]\s*|\s*$)/);
			if (match && match[1].includes('-')) {
				return match[1];
			}
		}
		
		return null;
	};
	
	// Append RLM feedback to a prompt
	const appendRlmFeedback = async (promptKey, feedbackEntry) => {
		if (!CONFIG.enableRlmFeedback || !promptKey) {
			return false;
		}
		
		try {
			await log("debug", "appending RLM feedback", { promptKey, feedback: feedbackEntry });
			
			const result = await execScroll([
				"prompts", "append-feedback",
				promptKey,
				feedbackEntry,
				"--source", "opencode-plugin"
			]);
			
			if (result) {
				await log("info", "RLM feedback appended", { promptKey });
				return true;
			}
		} catch (e) {
			await log("warn", "failed to append RLM feedback", { 
				promptKey, 
				error: String(e) 
			});
		}
		
		return false;
	};
	
	// Analyze prompt correlation with suggestion
	const analyzePromptCorrelation = async (userPrompt) => {
		if (!lastSuggestion || !lastSuggestionTimestamp) {
			return null;
		}
		
		const now = Date.now();
		const timeDiff = now - lastSuggestionTimestamp;
		
		// Outside correlation window
		if (timeDiff > SUGGESTION_CORRELATION_WINDOW_MS) {
			return null;
		}
		
		const suggestionKey = lastSuggestionPromptKey;
		if (!suggestionKey) {
			return null;
		}
		
		// Check if user prompt matches or differs from suggestion
		const userPromptLower = userPrompt.toLowerCase().trim();
		const suggestionLower = lastSuggestion.toLowerCase().trim();
		
		// Extract keywords from both
		const userKeywords = userPromptLower.split(/\s+/);
		const suggestionKeywords = suggestionLower.split(/\s+/);
		
		// Check for significant overlap
		const overlap = userKeywords.filter(k => suggestionKeywords.includes(k));
		const overlapRatio = overlap.length / Math.max(userKeywords.length, suggestionKeywords.length);
		
		// Determine correlation type
		if (overlapRatio > 0.7) {
			return { type: "accepted", key: suggestionKey, overlap: overlapRatio };
		} else if (overlapRatio > 0.3) {
			// Steering - user modified the suggestion
			const addedKeywords = userKeywords.filter(k => !suggestionKeywords.includes(k));
			const removedKeywords = suggestionKeywords.filter(k => !userKeywords.includes(k));
			
			return { 
				type: "steered", 
				key: suggestionKey, 
				overlap: overlapRatio,
				added: addedKeywords,
				removed: removedKeywords
			};
		} else {
			return { type: "rejected", key: suggestionKey, overlap: overlapRatio };
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

					// Store suggestion for correlation tracking
					lastSuggestion = prompt;
					lastSuggestionTimestamp = Date.now();
					lastSuggestionPromptKey = parseSuggestionKey(suggestions);
					
					await log("debug", "suggestion stored for correlation", {
						key: lastSuggestionPromptKey,
						timestamp: lastSuggestionTimestamp
					});

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
		// Structured hook: reliable way to capture user prompts with model/session info
		"chat.message": async (input, output) => {
			// input: { sessionID, agent, model: {providerID, modelID}, messageID }
			// output: { message: UserMessage, parts: Part[] }
			currentSessionId = input?.sessionID ?? currentSessionId;
			currentModel = input?.model?.modelID ?? currentModel;

			const textParts = (output?.parts ?? []).filter(p => p.type === "text");
			const content = textParts.map(p => p.text ?? "").join("\n");
			if (!content.trim()) return;

			promptCaptured = true;
			assistantParts = [];

			// Analyze correlation with previous suggestion
			const correlation = await analyzePromptCorrelation(content);
			if (correlation) {
				await log("debug", "prompt correlation detected", correlation);

				let feedbackEntry = "";
				const date = new Date().toISOString().split('T')[0];

				switch (correlation.type) {
					case "accepted":
						feedbackEntry = `[${date}] Prompt suggestion accepted (overlap: ${(correlation.overlap * 100).toFixed(0)}%)`;
						break;
					case "steered": {
						const added = correlation.added?.slice(0, 3).join(", ") || "none";
						const removed = correlation.removed?.slice(0, 3).join(", ") || "none";
						feedbackEntry = `[${date}] User steered from suggestion - Added keywords: "${added}" - Removed: "${removed}"`;
						break;
					}
					case "rejected":
						feedbackEntry = `[${date}] Prompt suggestion rejected (low overlap: ${(correlation.overlap * 100).toFixed(0)}%)`;
						break;
				}

				if (feedbackEntry) {
					await appendRlmFeedback(correlation.key, feedbackEntry);
				}

				lastSuggestion = null;
				lastSuggestionTimestamp = null;
				lastSuggestionPromptKey = null;
			}

			try {
				await execScroll(["capture", "hook", "prompt"], {
					PROMPT: content,
					SCROLL_SESSION_ID: currentSessionId ?? "",
					SCROLL_MODEL: currentModel ?? "",
					SCROLL_WORKSPACE: directory ?? "",
				});
			} catch (e) {
				await log("warn", "capture prompt failed", { error: String(e) });
				promptCaptured = false;
			}
		},

		event: async ({ event }) => {
			const { type: eventType, properties } = event;

			switch (eventType) {
				case "message.part.updated": {
					// OpenCode schema: { part: { id, sessionID, messageID, type, text }, delta? }
					const part = properties?.part;
					if (part?.type === "text" && promptCaptured) {
						// Accumulate assistant text parts during streaming
						assistantParts.push(part.text ?? "");
					}
					break;
				}

				case "message.updated": {
					// OpenCode schema: { info: { id, sessionID, role, modelID, providerID, cost, tokens: {input, output, reasoning, cache} } }
					const info = properties?.info;
					if (info?.role === "assistant" && promptCaptured) {
						const responseText = assistantParts.join("");
						if (responseText.trim()) {
							try {
								await execScroll(["capture", "hook", "response"], {
									CLAUDE_RESPONSE: responseText,
									SCROLL_SESSION_ID: info.sessionID ?? currentSessionId ?? "",
									SCROLL_MODEL: info.modelID ?? currentModel ?? "",
									TOKENS_INPUT: String(info.tokens?.input ?? ""),
									TOKENS_OUTPUT: String(info.tokens?.output ?? ""),
								});
							} catch (e) {
								await log("warn", "capture response failed", { error: String(e) });
							}
						}
						promptCaptured = false;
						assistantParts = [];
					}
					break;
				}

				case "session.created": {
					// OpenCode schema: { info: { id, parentID, directory, title, ... } }
					const info = properties?.info;
					currentSessionId = info?.id ?? null;
					promptCaptured = false;
					assistantParts = [];
					await log("info", "session created", {
						sessionId: currentSessionId ?? "unknown",
						isSubagent: info?.parentID != null,
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