import express from "express";
import cors from "cors";
import { query } from "@anthropic-ai/claude-agent-sdk";

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
 * Chat endpoint - streams responses via SSE
 * Uses MCP servers configured in ~/.claude/ or vault's .claude/
 */
app.post("/chat", async (req, res) => {
  const { message, systemPrompt, sessionId, workingDirectory, activeFile } = req.body;

  console.log("[Proxy] Received chat request:", {
    message,
    sessionId: sessionId || "new session",
    workingDirectory: workingDirectory || "default",
    activeFile: activeFile?.path || "none"
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

    return prompt;
  };

  const buildQueryOptions = (resumeSessionId) => ({
    model: "claude-haiku-4-5",
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
          // User messages from conversation history replay - safe to ignore
          console.log("[Proxy] User message (history replay)");
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
