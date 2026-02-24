import { existsSync } from "fs";
import { execSync } from "child_process";
import crypto from "crypto";
import { Router } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { log, logError } from "../log.js";
import { getTranscriptPath, getSummariesPath, readLatestSegmentMessages, generateCompactSummary, appendSummary } from "../transcript.js";
import { updateSessionEntry, collectFilePaths, extractTitleFromTranscript, countTranscriptMessages, countUserOnlyMessages } from "../sessions.js";
import { getMarkersPath, appendMarker } from "../markers.js";
import { computeToolDescription, formatToolInput, extractToolResultContent } from "../toolFormat.js";
import { createAsyncIterableController } from "../asyncIterableController.js";
import { registerQuery, getQuery, removeQuery, updateQuerySession } from "../queryRegistry.js";

/**
 * Resolve the current node binary path.
 * process.execPath can go stale after `brew upgrade node` — the Cellar
 * versioned path gets deleted while the running process keeps its old value.
 */
function resolveNodeBinary() {
  if (existsSync(process.execPath)) return process.execPath;
  try {
    return execSync("which node", { encoding: "utf8" }).trim();
  } catch {
    return "node";
  }
}

const router = Router();

/**
 * Chat endpoint - streams responses via SSE
 * Uses MCP servers configured in ~/.claude/ or vault's .claude/
 */
router.post("/chat", async (req, res) => {
  const { message, systemPrompt, sessionId, activeFile, mentionedFiles, selection, model, relevantNotes, flashcardMeta, sessionMeta } = req.body;
  const vaultPath = req.vaultPath;

  log("[Proxy] Received chat request:", {
    message,
    sessionId: sessionId || "new session",
    vaultPath,
    activeFile: activeFile?.path || "none",
    selection: selection ? `${selection.text.slice(0, 50)}... (from ${selection.filePath})` : "none",
    mentionedFiles: mentionedFiles?.map(f => f.path) || [],
    relevantNotes: relevantNotes?.length || 0
  });

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, data) => {
    const event = { type, ...data };
    log("[Proxy] Sending event:", event);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const buildSystemPrompt = () => {
    let prompt = systemPrompt || `You are a helpful assistant that answers questions about the user's Obsidian vault.
Use available MCP tools to search and read notes when needed.
Be concise and helpful.`;

    prompt += `\n\n## Output Format: Diagrams
When creating a diagram, flowchart, graph, or visual representation, use a \`\`\`dot code block (Graphviz DOT language). It will be rendered as an interactive SVG. Do not use ASCII art for diagrams.

### Diagram verification workflow
Before including DOT code blocks in your reply, verify each one visually. Use \`/tmp/dot/\` with numbered files when producing multiple diagrams:
1. \`mkdir -p /tmp/dot\`
2. Write each DOT source to \`/tmp/dot/1.dot\`, \`/tmp/dot/2.dot\`, etc.
3. Render all at once: \`for f in /tmp/dot/*.dot; do dot -Tpng "$f" -o "\${f%.dot}.png"; done\`
4. Read the resulting PNGs to visually inspect the rendered results.
5. If any layout, labels, or edges look wrong, revise that DOT source and re-render.
6. Once all diagrams look correct, include the final DOT sources in \`\`\`dot code blocks in your reply.`;

    if (activeFile) {
      prompt += `\n\n## Current Context\nThe user is currently viewing: **${activeFile.path}**\nUse MCP tools to read this file if relevant to their question.`;
    }

    if (selection && selection.text) {
      const lineInfo = selection.startLine
        ? selection.startLine === selection.endLine
          ? ` (line ${selection.startLine})`
          : ` (lines ${selection.startLine}-${selection.endLine})`
        : "";
      prompt += `\n\n## Selected Text\nThe user has selected the following text from **${selection.filePath}**${lineInfo}:\n\`\`\`\n${selection.text}\n\`\`\`\nThis selection is likely central to their question. Address it directly.`;
    }

    if (mentionedFiles && mentionedFiles.length > 0) {
      const fileList = mentionedFiles.map(f => `- ${f.path}`).join("\n");
      prompt += `\n\n## Referenced Files\nThe user has explicitly mentioned the following files (using @[[path]] syntax). Use MCP tools to read these files as they are likely central to their question:\n${fileList}`;
    }

    if (relevantNotes && relevantNotes.length > 0) {
      const notesList = relevantNotes.map(note => {
        const preview = note.content.slice(0, 200).replace(/\n/g, " ").trim();
        const truncated = note.content.length > 200 ? preview + "..." : preview;
        return `- **${note.title}** (${note.path}): ${truncated}`;
      }).join("\n");
      prompt += `\n\n## Relevant Notes (auto-included based on similarity)\nThe following notes are semantically related to the current context. Consider them when answering:\n${notesList}`;
    }

    return prompt;
  };

  // Generate a queryId for this request so clients can inject messages / interrupt
  const queryId = crypto.randomUUID();

  // Create the async iterable controller for streaming input
  const inputController = createAsyncIterableController();

  // Push the initial user message into the iterable
  inputController.push({
    type: "user",
    message: { role: "user", content: message },
    parent_tool_use_id: null,
  });

  // Send the queryId to the client immediately after SSE headers
  sendEvent("query_ready", { queryId });

  // Track the resolved session ID (set in runQuery, used in finally for registry update)
  let resolvedSessionId = sessionId || null;

  const buildQueryOptions = (resumeSessionId) => ({
    model: model || "haiku",
    systemPrompt: buildSystemPrompt(),
    permissionMode: "bypassPermissions",
    maxTurns: 100,
    settingSources: ["user", "project", "local"],
    cwd: vaultPath,
    executable: resolveNodeBinary(),
    ...(resumeSessionId && { resume: resumeSessionId }),
  });

  const runQuery = async (resumeSessionId) => {
    log("[Proxy] Starting query with cwd:", vaultPath, resumeSessionId ? `(resuming ${resumeSessionId})` : "(new session)");

    const response = query({
      prompt: inputController.iterable,
      options: buildQueryOptions(resumeSessionId),
    });

    // Register in the query registry so /inject and /interrupt can find it
    registerQuery(queryId, response, inputController, resumeSessionId);

    let messageCount = 0;
    let lastContent = "";
    let currentSessionId = resumeSessionId;

    for await (const msg of response) {
      messageCount++;
      console.log(`[Proxy] Message ${messageCount}:`, msg.type, msg.subtype || "", JSON.stringify(msg).slice(0, 200));

      switch (msg.type) {
        case "assistant": {
          // Gather content blocks from either msg.content or msg.message.content
          const contentBlocks = [];
          if (msg.content) {
            if (typeof msg.content === "string") {
              contentBlocks.push({ type: "text", text: msg.content });
            } else if (Array.isArray(msg.content)) {
              contentBlocks.push(...msg.content);
            }
          }
          if (msg.message?.content && Array.isArray(msg.message.content)) {
            // SDK sometimes wraps content — only add blocks we haven't seen
            if (!msg.content || !Array.isArray(msg.content)) {
              contentBlocks.push(...msg.message.content);
            }
          }

          for (const block of contentBlocks) {
            if (block.type === "text") {
              lastContent = block.text;
              sendEvent("text", { content: block.text });
            } else if (block.type === "tool_use") {
              const description = computeToolDescription(block.name, block.input);
              const input = formatToolInput(block.name, block.input);
              sendEvent("tool_use", {
                toolName: block.name,
                toolUseId: block.id,
                description,
                input,
              });
            }
          }
          break;
        }

        case "error":
          logError("[Proxy] Error message:", msg);
          sendEvent("error", {
            content: msg.error?.message || msg.error || JSON.stringify(msg)
          });
          break;

        case "system":
          log("[Proxy] System message:", msg.subtype);
          // Capture session ID on init
          if (msg.subtype === "init" && msg.session_id) {
            currentSessionId = msg.session_id;
            resolvedSessionId = msg.session_id;
            updateQuerySession(queryId, currentSessionId);
            log("[Proxy] Session ID:", currentSessionId);
            sendEvent("session", { sessionId: currentSessionId });
          }
          // Forward compact boundary events to client (with synthetic summary)
          if (msg.subtype === "compact_boundary") {
            log("[Proxy] Compact boundary:", msg.compact_metadata);
            const preTokens = msg.compact_metadata?.pre_tokens || 0;
            const trigger = msg.compact_metadata?.trigger || "manual";

            // Generate synthetic summary from the compacted segment
            const transcriptPath = getTranscriptPath(vaultPath, currentSessionId);
            const segmentMessages = readLatestSegmentMessages(transcriptPath);
            const summary = await generateCompactSummary(segmentMessages);

            // Persist summary to sidecar file
            if (summary && currentSessionId) {
              const summariesPath = getSummariesPath(vaultPath, currentSessionId);
              appendSummary(summariesPath, { timestamp: Date.now(), preTokens, summary });
            }

            sendEvent("compact_boundary", {
              preTokens,
              trigger,
              ...(summary && { summary }),
            });
          }
          break;

        case "result":
          log("[Proxy] Result:", msg.subtype);
          if (msg.subtype === "success") {
            sendEvent("result", {
              durationMs: msg.duration_ms,
              numTurns: msg.num_turns,
              totalCostUsd: msg.total_cost_usd,
            });
          } else if (msg.subtype?.startsWith("error")) {
            sendEvent("error", {
              content: msg.error_message || `Error: ${msg.subtype}`
            });
          }
          break;

        case "user": {
          // SDK replay messages have no useful content for the UI
          if (msg.isReplay) {
            log("[Proxy] User message (replay, ignored)");
            break;
          }

          // Tool result messages carry the output of a tool call
          const msgContent = msg.message?.content;
          if (Array.isArray(msgContent)) {
            const toolResultBlock = msgContent.find(b => b.type === "tool_result");
            if (toolResultBlock) {
              const result = extractToolResultContent(msg);
              sendEvent("tool_result", {
                toolUseId: toolResultBlock.tool_use_id,
                content: result.text,
                isError: result.isError,
              });
              break;
            }
          }

          // Other user messages (initial prompt echo, document blocks) — ignore
          log("[Proxy] User message (non-tool, ignored)");
          break;
        }

        default:
          log("[Proxy] Unknown message type:", msg.type);
      }
    }

    console.log(`[Proxy] Query complete. Total messages: ${messageCount}, lastContent length: ${lastContent.length}`);
    sendEvent("done", { sessionId: currentSessionId });
  };

  try {
    await runQuery(sessionId);
  } catch (error) {
    // If session resume fails (exit code 1), retry without session
    if (sessionId && error.message?.includes("exited with code 1")) {
      log("[Proxy] Session resume failed, starting fresh session");
      try {
        await runQuery(null);
      } catch (retryError) {
        logError("[Proxy] Retry failed:", retryError);
        sendEvent("error", { content: retryError.message || "Unknown error" });
      }
    } else {
      logError("[Proxy] Chat error:", error);
      sendEvent("error", { content: error.message || "Unknown error" });
    }
  } finally {
    // Clean up query registry
    removeQuery(queryId);
    inputController.close();

    // Update session registry
    try {
      if (resolvedSessionId) {
        const filePaths = collectFilePaths(req.body);
        const transcriptPath = getTranscriptPath(vaultPath, resolvedSessionId);
        const title = extractTitleFromTranscript(transcriptPath);
        const msgCount = countTranscriptMessages(transcriptPath);

        const registryUpdates = {
          title: title || undefined,
          model: model || "haiku",
          messageCount: msgCount,
          updatedAt: Date.now(),
          files: filePaths,
        };

        // Merge session type/epoch if provided (flashcard study sessions)
        if (sessionMeta) {
          if (sessionMeta.type) registryUpdates.type = sessionMeta.type;
          if (sessionMeta.epoch) registryUpdates.epoch = sessionMeta.epoch;
        }

        updateSessionEntry(vaultPath, resolvedSessionId, registryUpdates);

        // Write marker entry to sidecar if flashcard metadata provided
        if (flashcardMeta) {
          const markersPath = getMarkersPath(vaultPath, resolvedSessionId);
          const userMsgCount = countUserOnlyMessages(transcriptPath);
          appendMarker(markersPath, {
            markerId: crypto.randomUUID(),
            flashcardId: flashcardMeta.cardId,
            sourceFile: flashcardMeta.sourceFile,
            question: flashcardMeta.question,
            userMessageIndex: userMsgCount > 0 ? userMsgCount - 1 : 0,
            createdAt: Date.now(),
          });
        }
      }
    } catch (regError) {
      logError("[Proxy] Failed to update session registry:", regError);
    }
    res.end();
  }
});

/**
 * Inject a follow-up message into an active streaming query.
 */
router.post("/chat/:queryId/inject", (req, res) => {
  const entry = getQuery(req.params.queryId);
  if (!entry) return res.status(404).json({ error: "Query not found or expired" });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  entry.inputController.push({
    type: "user",
    message: { role: "user", content: message },
    parent_tool_use_id: null,
  });

  res.status(202).json({ status: "injected", queryId: req.params.queryId });
});

/**
 * Interrupt an active streaming query.
 */
router.post("/chat/:queryId/interrupt", async (req, res) => {
  const entry = getQuery(req.params.queryId);
  if (!entry) return res.status(404).json({ error: "Query not found or expired" });

  try {
    await entry.query.interrupt();
    res.status(202).json({ status: "interrupted", queryId: req.params.queryId });
  } catch (err) {
    logError("[Proxy] Interrupt failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Check whether a query is still active (for reconnection logic).
 */
router.get("/chat/:queryId/status", (req, res) => {
  const entry = getQuery(req.params.queryId);
  res.json({ active: !!entry, ...(entry && { sessionId: entry.sessionId }) });
});

export default router;
