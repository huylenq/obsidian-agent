import express from "express";
import cors from "cors";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const PORT = process.env.PORT || 27182;
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

  console.log("[Proxy] Fetching history for session:", sessionId);

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
      console.log("[Proxy] Transcript file not found at:", transcriptPath);
      return res.json({ messages: [] });
    }

    console.log("[Proxy] Reading transcript from:", transcriptPath);

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
        console.log("[Proxy] Skipping malformed line");
      }
    }

    console.log("[Proxy] Found", messages.length, "messages in history");
    res.json({ messages });

  } catch (error) {
    console.error("[Proxy] Error reading history:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Chat endpoint - streams responses via SSE
 * Uses MCP servers configured in ~/.claude/ or vault's .claude/
 */
app.post("/chat", async (req, res) => {
  const { message, systemPrompt, sessionId, workingDirectory, activeFile, mentionedFiles } = req.body;

  console.log("[Proxy] Received chat request:", {
    message,
    sessionId: sessionId || "new session",
    workingDirectory: workingDirectory || "default",
    activeFile: activeFile?.path || "none",
    mentionedFiles: mentionedFiles?.map(f => f.path) || []
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
    console.log("[Proxy] Sending event:", event);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const buildSystemPrompt = () => {
    let prompt = systemPrompt || `You are a helpful assistant that answers questions about the user's Obsidian vault.
Use available MCP tools to search and read notes when needed.
Be concise and helpful.`;

    if (activeFile) {
      prompt += `\n\n## Current Context\nThe user is currently viewing: **${activeFile.path}**\nUse MCP tools to read this file if relevant to their question.`;
    }

    if (mentionedFiles && mentionedFiles.length > 0) {
      const fileList = mentionedFiles.map(f => `- ${f.path}`).join("\n");
      prompt += `\n\n## Referenced Files\nThe user has explicitly mentioned the following files (using @[[path]] syntax). Use MCP tools to read these files as they are likely central to their question:\n${fileList}`;
    }

    return prompt;
  };

  const buildQueryOptions = (resumeSessionId) => ({
    model: "haiku",
    systemPrompt: buildSystemPrompt(),
    permissionMode: "bypassPermissions",
    maxTurns: 10,
    settingSources: ["user", "project", "local"],
    cwd: workingDirectory,
    ...(resumeSessionId && { resume: resumeSessionId }),
  });

  const runQuery = async (resumeSessionId) => {
    console.log("[Proxy] Starting query with cwd:", workingDirectory, resumeSessionId ? `(resuming ${resumeSessionId})` : "(new session)");

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
          console.error("[Proxy] Error message:", msg);
          sendEvent("error", {
            content: msg.error?.message || msg.error || JSON.stringify(msg)
          });
          break;

        case "system":
          console.log("[Proxy] System message:", msg.subtype);
          // Capture session ID on init
          if (msg.subtype === "init" && msg.session_id) {
            currentSessionId = msg.session_id;
            console.log("[Proxy] Session ID:", currentSessionId);
            sendEvent("session", { sessionId: currentSessionId });
          }
          break;

        case "result":
          console.log("[Proxy] Result:", msg.subtype);
          if (msg.subtype?.startsWith("error")) {
            sendEvent("error", {
              content: msg.error_message || `Error: ${msg.subtype}`
            });
          }
          break;

        case "user":
          // User messages from conversation history replay - ignore
          // History is loaded via /history endpoint from transcript files
          console.log("[Proxy] User message (history replay, ignored)");
          break;

        default:
          console.log("[Proxy] Unknown message type:", msg.type);
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
      console.log("[Proxy] Session resume failed, starting fresh session");
      try {
        await runQuery(null);
      } catch (retryError) {
        console.error("[Proxy] Retry failed:", retryError);
        sendEvent("error", { content: retryError.message || "Unknown error" });
      }
    } else {
      console.error("[Proxy] Chat error:", error);
      sendEvent("error", { content: error.message || "Unknown error" });
    }
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[Claude Agent Proxy] Running on http://localhost:${PORT}`);
  console.log(`[Claude Agent Proxy] Health check: http://localhost:${PORT}/health`);
});
