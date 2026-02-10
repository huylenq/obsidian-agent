import express from "express";
import cors from "cors";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const PORT = process.env.PORT || 27182;
const LOG_FILE = join(homedir(), ".claude-agent-proxy.log");

// Initialize log file
writeFileSync(LOG_FILE, `\n=== Server started at ${new Date().toISOString()} ===\n`);

function log(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}\n`;
  appendFileSync(LOG_FILE, message);
  console.log(...args);
}

function logError(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ERROR: ${args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}\n`;
  appendFileSync(LOG_FILE, message);
  console.error(...args);
}
const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * Get session history from transcript file
 * Claude Code stores transcripts at ~/.claude/projects/{encoded-path}/{session-id}.jsonl
 */
app.post("/history", (req, res) => {
  const { sessionId, workingDirectory } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  log("[Proxy] Fetching history for session:", sessionId);

  try {
    // Encode the working directory path the same way Claude Code does
    // Claude Code replaces /, spaces, and ~ with dashes
    // e.g., /Users/huy/Library/Mobile Documents/iCloud~md~obsidian/Documents/IWE
    //    -> -Users-huy-Library-Mobile-Documents-iCloud-md-obsidian-Documents-IWE
    const encodedPath = workingDirectory
      ? workingDirectory.replace(/[\/\s~]/g, "-")
      : "";

    const claudeDir = join(homedir(), ".claude", "projects");

    // Try to find the transcript file
    let transcriptPath = join(claudeDir, encodedPath, `${sessionId}.jsonl`);

    if (!existsSync(transcriptPath)) {
      log("[Proxy] Transcript file not found at:", transcriptPath);
      return res.json({ messages: [] });
    }

    log("[Proxy] Reading transcript from:", transcriptPath);

    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    const messages = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Only process user and assistant messages
        if (entry.type === "user" || entry.type === "assistant") {
          let textContent = "";

          // Parse the nested message JSON
          if (entry.message) {
            const msg = typeof entry.message === "string"
              ? JSON.parse(entry.message)
              : entry.message;

            if (msg.content) {
              if (typeof msg.content === "string") {
                textContent = msg.content;
              } else if (Array.isArray(msg.content)) {
                // Extract text from content blocks
                for (const block of msg.content) {
                  if (block.type === "text") {
                    textContent += block.text;
                  }
                }
              }
            }
          }

          if (textContent) {
            messages.push({
              role: entry.type,
              content: textContent,
              timestamp: entry.timestamp || Date.now(),
            });
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        log("[Proxy] Skipping malformed line");
      }
    }

    log("[Proxy] Found", messages.length, "messages in history");
    res.json({ messages });

  } catch (error) {
    logError("[Proxy] Error reading history:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Chat endpoint - streams responses via SSE
 * Uses MCP servers configured in ~/.claude/ or vault's .claude/
 */
app.post("/chat", async (req, res) => {
  const { message, systemPrompt, sessionId, workingDirectory, activeFile, mentionedFiles, selection, model, relevantNotes } = req.body;

  log("[Proxy] Received chat request:", {
    message,
    sessionId: sessionId || "new session",
    workingDirectory: workingDirectory || "default",
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

  const buildQueryOptions = (resumeSessionId) => ({
    model: model || "haiku",
    systemPrompt: buildSystemPrompt(),
    permissionMode: "bypassPermissions",
    maxTurns: 10,
    settingSources: ["user", "project", "local"],
    cwd: workingDirectory,
    ...(resumeSessionId && { resume: resumeSessionId }),
  });

  const runQuery = async (resumeSessionId) => {
    log("[Proxy] Starting query with cwd:", workingDirectory, resumeSessionId ? `(resuming ${resumeSessionId})` : "(new session)");

    const response = query({
      prompt: message,
      options: buildQueryOptions(resumeSessionId),
    });

    let messageCount = 0;
    let lastContent = "";
    let currentSessionId = resumeSessionId;

    for await (const msg of response) {
      messageCount++;
      console.log(`[Proxy] Message ${messageCount}:`, msg.type, msg.subtype || "", JSON.stringify(msg).slice(0, 200));

      switch (msg.type) {
        case "assistant":
          if (msg.content) {
            if (typeof msg.content === "string") {
              lastContent = msg.content;
              sendEvent("text", { content: msg.content });
            } else if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === "text") {
                  lastContent = block.text;
                  sendEvent("text", { content: block.text });
                }
              }
            }
          }
          // Also check msg.message?.content (SDK sometimes wraps it)
          if (msg.message?.content) {
            if (Array.isArray(msg.message.content)) {
              for (const block of msg.message.content) {
                if (block.type === "text") {
                  lastContent = block.text;
                  sendEvent("text", { content: block.text });
                }
              }
            }
          }
          break;

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
            log("[Proxy] Session ID:", currentSessionId);
            sendEvent("session", { sessionId: currentSessionId });
          }
          break;

        case "result":
          log("[Proxy] Result:", msg.subtype);
          if (msg.subtype?.startsWith("error")) {
            sendEvent("error", {
              content: msg.error_message || `Error: ${msg.subtype}`
            });
          }
          break;

        case "user":
          // User messages from conversation history replay - ignore
          // History is loaded via /history endpoint from transcript files
          log("[Proxy] User message (history replay, ignored)", msg);
          break;

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
    res.end();
  }
});

app.listen(PORT, () => {
  log(`[Claude Agent Proxy] Running on http://localhost:${PORT}`);
  log(`[Claude Agent Proxy] Health check: http://localhost:${PORT}/health`);
});
