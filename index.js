// Sage OpenCode plugin: capture + suggest + RLM feedback combined
//
// Uses the documented OpenCode plugin event handler pattern.
// Spawns sage commands via the `$` shell helper for portability.
// Now includes RLM feedback appending when steering is detected.

export const SagePlugin = async ({ client, $, directory }) => {
  const CONFIG = {
    sageBin: process.env.SAGE_BIN || "sage",
    suggestLimit: Number.parseInt(process.env.SAGE_SUGGEST_LIMIT || "3", 10),
    debounceMs: Number.parseInt(process.env.SAGE_SUGGEST_DEBOUNCE_MS || "800", 10),
    provision: (process.env.SAGE_SUGGEST_PROVISION || "1") === "1",
    dryRun: (process.env.SAGE_PLUGIN_DRY_RUN || "0") === "1",
    enableRlmFeedback: (process.env.SAGE_RLM_FEEDBACK || "1") === "1",
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
  let lastSuggestionPromptKey = null; // qualified: library/key
  let lastSuggestionId = null;
  let lastShownPromptKeys = [];
  let lastAcceptedFeedbackSent = false;
  let lastImplicitFeedbackSent = false;
  const SUGGESTION_CORRELATION_WINDOW_MS = 30000; // 30 second window

  const parsePromptKeyMarkers = (text) => {
    // Explicit markers only; no fuzzy matching.
    // Marker format: [[sage:prompt_key=library/key]]
    const re = /\[\[sage:prompt_key=([^\]]+)\]\]/g;
    const keys = new Set();
    for (;;) {
      const m = re.exec(text);
      if (!m) break;
      const key = (m[1] || "").trim();
      if (key) keys.add(key);
    }
    return Array.from(keys);
  };

  const recordPromptSuggestion = async ({
    suggestionId,
    prompt,
    shownPromptKeys,
    source,
    attributesJson,
  }) => {
    try {
      await execSage([
        "suggest",
        "prompt",
        "capture",
        suggestionId,
        prompt,
        "--source",
        source,
        "--shown",
        ...shownPromptKeys,
        ...(attributesJson ? ["--attributes-json", attributesJson] : []),
      ]);
      return true;
    } catch (e) {
      await log("debug", "prompt suggestion capture failed (daemon may be down)", {
        error: String(e),
      });
      return false;
    }
  };

  const recordPromptSuggestionFeedback = async ({ suggestionId, events }) => {
    try {
      await execSage([
        "suggest",
        "prompt",
        "feedback",
        suggestionId,
        "--events-json",
        JSON.stringify(events),
      ]);
      return true;
    } catch (e) {
      await log("debug", "prompt suggestion feedback failed (daemon may be down)", {
        error: String(e),
      });
      return false;
    }
  };

  const log = async (level, message, extra = {}) => {
    try {
      if (client?.app?.log) {
        await client.app.log({
          service: "sage-plugin",
          level,
          message,
          extra,
        });
      } else {
        console.log(`[sage-plugin:${level}]`, message, extra);
      }
    } catch {
      /* logging should never break the plugin */
    }
  };

  const execSage = async (args, env = {}) => {
    if (CONFIG.dryRun) return "";

    const sageEnv = { ...env, SAGE_SOURCE: "opencode" };

    try {
      if ($) {
        // Use OpenCode's $ shell helper for portability
        const cmd = [CONFIG.sageBin, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
        const result = await $({ env: sageEnv })`${cmd}`;
        return (result?.stdout ?? result ?? "").toString().trim();
      }
      // Fallback to Bun.spawn if $ not available
      if (typeof Bun !== "undefined") {
        const proc = Bun.spawn([CONFIG.sageBin, ...args], {
          env: { ...process.env, ...sageEnv },
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        return stdout.trim();
      }
      return "";
    } catch (e) {
      throw new Error(`sage command failed: ${e.message || e}`);
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
    const lines = suggestionText.split("\n");
    for (const line of lines) {
      // Look for common prompt key patterns
      const match = line.match(/^\s*[-•*]?\s*([a-z0-9-]+)(?:\s*[-:]\s*|\s*$)/);
      if (match?.[1]?.includes("-")) {
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
      await log("debug", "appending RLM feedback", {
        promptKey,
        feedback: feedbackEntry,
      });

      const result = await execSage([
        "suggest",
        "feedback",
        promptKey,
        feedbackEntry,
        "--source",
        "opencode-plugin",
      ]);

      if (result) {
        await log("info", "RLM feedback appended", { promptKey });
        return true;
      }
    } catch (e) {
      await log("warn", "failed to append RLM feedback", {
        promptKey,
        error: String(e),
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
    const overlap = userKeywords.filter((k) => suggestionKeywords.includes(k));
    const overlapRatio = overlap.length / Math.max(userKeywords.length, suggestionKeywords.length);

    // Determine correlation type
    if (overlapRatio > 0.7) {
      return { type: "accepted", key: suggestionKey, overlap: overlapRatio };
    }
    if (overlapRatio > 0.3) {
      // Steering - user modified the suggestion
      const addedKeywords = userKeywords.filter((k) => !suggestionKeywords.includes(k));
      const removedKeywords = suggestionKeywords.filter((k) => !userKeywords.includes(k));

      return {
        type: "steered",
        key: suggestionKey,
        overlap: overlapRatio,
        added: addedKeywords,
        removed: removedKeywords,
      };
    }
    return { type: "rejected", key: suggestionKey, overlap: overlapRatio };
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

        await log("debug", "running sage suggest", {
          cwd: directory,
          prompt_len: prompt.length,
        });

        try {
          const args = [
            "suggest",
            "skill",
            prompt,
            "--format",
            "json",
            "--limit",
            CONFIG.suggestLimit.toString(),
          ];
          if (CONFIG.provision) args.push("--provision");

          const output = await execSage(args);
          if (!output) return;
          if (current !== runId) return;

          let renderedOutput = "";
          let correlationText = "";
          let primaryKey = null;
          let shownKeys = [];

          try {
            const json = JSON.parse(output);
            if (json.results && Array.isArray(json.results) && json.results.length > 0) {
              // Extract qualified keys for capture/correlation
              shownKeys = json.results
                .map((r) => (r.library ? `${r.library}/${r.key}` : r.key))
                .filter(Boolean);
              primaryKey = shownKeys[0] || null;

              // Build correlation text from all results (titles/descriptions/keys)
              // We exclude full content to keep overlap ratio meaningful
              correlationText = json.results
                .map((r) => `${r.name} ${r.description || ""} ${r.key}`)
                .join(" ");

              // Render output
              renderedOutput = json.results
                .map((r) => {
                  const qualifiedKey = r.library ? `${r.library}/${r.key}` : r.key;
                  let block = `### ${r.name} (key: ${qualifiedKey})\n`;
                  if (r.library) block += `*Library: ${r.library}*\n`;
                  if (r.description) block += `${r.description}\n`;
                  if (r.content) block += `\n\`\`\`\n${r.content}\n\`\`\`\n`;
                  block += `\n<!-- If you use this suggestion, include marker: [[sage:prompt_key=${qualifiedKey}]] -->\n`;
                  return block;
                })
                .join("\n---\n\n");
            }
          } catch (e) {
            // Fallback: If JSON parse fails, assume it might be plain text or broken JSON.
            // We treat the raw output as the suggestion.
            renderedOutput = output;
            primaryKey = parseSuggestionKey(output);
            correlationText = output;
          }

          if (!renderedOutput) return;

          const suggestionId =
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `sage-suggest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

          // Store suggestion for correlation tracking
          lastSuggestion = correlationText;
          lastSuggestionTimestamp = Date.now();
          lastSuggestionPromptKey = primaryKey;
          lastSuggestionId = suggestionId;
          lastShownPromptKeys = shownKeys;
          lastAcceptedFeedbackSent = false;
          lastImplicitFeedbackSent = false;

          // Capture the suggestion to daemon (best-effort)
          await recordPromptSuggestion({
            suggestionId,
            prompt,
            shownPromptKeys: shownKeys,
            source: "opencode",
            attributesJson: JSON.stringify({
              opencode: {
                sessionId: currentSessionId,
                model: currentModel,
                workspace: directory,
              },
            }),
          });

          await log("debug", "suggestion stored for correlation", {
            key: lastSuggestionPromptKey,
            timestamp: lastSuggestionTimestamp,
          });

          lastInjected = prompt;
          await client.tui.appendPrompt({
            body: { text: `\n\n${renderedOutput}\n` },
          });
        } catch (e) {
          await log("warn", "sage suggest failed", { error: String(e) });
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

      const textParts = (output?.parts ?? []).filter((p) => p.type === "text");
      const content = textParts.map((p) => p.text ?? "").join("\n");
      if (!content.trim()) return;

      promptCaptured = true;
      assistantParts = [];

      // Analyze correlation with previous suggestion
      const correlation = await analyzePromptCorrelation(content);
      if (correlation) {
        await log("debug", "prompt correlation detected", correlation);

        let feedbackEntry = "";
        const date = new Date().toISOString().split("T")[0];

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

        // Also record prompt-suggestion feedback to daemon (best-effort)
        if (lastSuggestionId && !lastAcceptedFeedbackSent) {
          await recordPromptSuggestionFeedback({
            suggestionId: lastSuggestionId,
            events: [
              {
                kind: correlation.type,
                prompt_key: correlation.key,
                confidence: correlation.overlap,
                features_json: JSON.stringify({ overlap: correlation.overlap }),
              },
            ],
          });
          lastAcceptedFeedbackSent = true;
        }

        // Keep suggestion state for implicit marker detection on assistant completion.
      }

      try {
        await execSage(["capture", "hook", "prompt"], {
          // Capture hook expects the prompt via stdin JSON (Claude Code) or env vars.
          // OpenCode plugin uses env vars.
          PROMPT: content,
          SAGE_SESSION_ID: currentSessionId ?? "",
          SAGE_MODEL: currentModel ?? "",
          SAGE_WORKSPACE: directory ?? "",
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
              // If assistant explicitly marks one suggested prompt key as used, record implicitly_helpful.
              if (
                lastSuggestionId &&
                lastSuggestionTimestamp &&
                !lastImplicitFeedbackSent &&
                Date.now() - lastSuggestionTimestamp <= SUGGESTION_CORRELATION_WINDOW_MS
              ) {
                const marked = parsePromptKeyMarkers(responseText);
                const allowed = new Set(lastShownPromptKeys || []);
                const matched = marked.filter((k) => allowed.has(k));
                if (matched.length === 1) {
                  await recordPromptSuggestionFeedback({
                    suggestionId: lastSuggestionId,
                    events: [
                      {
                        kind: "implicitly_helpful",
                        prompt_key: matched[0],
                        confidence: 1.0,
                        features_json: JSON.stringify({ marker: true }),
                      },
                    ],
                  });
                  lastImplicitFeedbackSent = true;
                }
              }

              try {
                await execSage(["capture", "hook", "response"], {
                  SAGE_SESSION_ID: info.sessionID ?? currentSessionId ?? "",
                  SAGE_MODEL: info.modelID ?? currentModel ?? "",
                  TOKENS_INPUT: String(info.tokens?.input ?? ""),
                  TOKENS_OUTPUT: String(info.tokens?.output ?? ""),
                  // Pass the actual response content for capture completion
                  SAGE_RESPONSE: responseText,
                });
              } catch (e) {
                await log("warn", "capture response failed", {
                  error: String(e),
                });
              }
            }
            promptCaptured = false;
            assistantParts = [];

            // Clear suggestion tracking once we've had a full assistant completion after it.
            if (
              lastSuggestionTimestamp &&
              Date.now() - lastSuggestionTimestamp > SUGGESTION_CORRELATION_WINDOW_MS
            ) {
              lastSuggestion = null;
              lastSuggestionTimestamp = null;
              lastSuggestionPromptKey = null;
              lastSuggestionId = null;
              lastShownPromptKeys = [];
              lastAcceptedFeedbackSent = false;
              lastImplicitFeedbackSent = false;
            }
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

export default SagePlugin;
