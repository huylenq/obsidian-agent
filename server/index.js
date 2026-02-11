import express from "express";
import cors from "cors";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const PORT = process.env.PORT || 27182;
const LOG_FILE = join(homedir(), ".claude-agent-proxy.log");
const COMPACT_SUMMARY_CWD = "/tmp/claude-agent-compact-summaries";

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

// ============================================================================
// Transcript & summary helpers
// ============================================================================

function encodePath(workingDirectory) {
  return workingDirectory ? workingDirectory.replace(/[\/\s~]/g, "-") : "";
}

function getTranscriptPath(workingDirectory, sessionId) {
  return join(homedir(), ".claude", "projects", encodePath(workingDirectory), `${sessionId}.jsonl`);
}

function getSummariesPath(workingDirectory, sessionId) {
  return join(homedir(), ".claude", "projects", encodePath(workingDirectory), `${sessionId}.summaries.json`);
}

/** Extract text content from a transcript entry's message field */
function extractTextFromEntry(entry) {
  if (!entry.message) return "";
  const msg = typeof entry.message === "string" ? JSON.parse(entry.message) : entry.message;
  if (!msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
  }
  return "";
}

/** Read user/assistant messages from the latest segment (after last compact_boundary) */
function readLatestSegmentMessages(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  let segment = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "system" && entry.subtype === "compact_boundary") {
        segment = []; // reset — only keep messages after the latest boundary
      } else if (entry.type === "user" || entry.type === "assistant") {
        const text = extractTextFromEntry(entry);
        if (text) segment.push({ role: entry.type, content: text });
      }
    } catch { /* skip malformed */ }
  }
  return segment;
}

/** Generate a compact summary via Agent SDK with a throwaway /tmp session */
async function generateCompactSummary(messages) {
  if (messages.length === 0) return null;

  // Cap at 30 messages, truncate each to 300 chars
  const capped = messages.slice(-30);
  const conversationText = capped
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `Summarize this conversation in 2-3 concise bullet points using the bullet character. Focus on topics discussed and key outcomes. Be very brief — no preamble.\n\nConversation:\n${conversationText}`;

  mkdirSync(COMPACT_SUMMARY_CWD, { recursive: true });

  try {
    log("[Proxy] Generating compact summary...");
    const response = query({
      prompt,
      options: {
        model: "haiku",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        cwd: COMPACT_SUMMARY_CWD,
        systemPrompt: "You are a conversation summarizer. Output only bullet points, nothing else. Use the bullet character for each point.",
      },
    });

    let summary = "";
    for await (const msg of response) {
      if (msg.type === "assistant") {
        if (typeof msg.content === "string") {
          summary = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") summary += block.text;
          }
        }
        if (msg.message?.content && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === "text") summary += block.text;
          }
        }
      }
    }

    const trimmed = summary.trim();
    log("[Proxy] Compact summary generated:", trimmed.slice(0, 200));
    return trimmed || null;
  } catch (error) {
    logError("[Proxy] Failed to generate compact summary:", error);
    return null;
  }
}

function loadSummaries(summariesPath) {
  if (!existsSync(summariesPath)) return [];
  try {
    return JSON.parse(readFileSync(summariesPath, "utf-8"));
  } catch { return []; }
}

function appendSummary(summariesPath, entry) {
  const summaries = loadSummaries(summariesPath);
  summaries.push(entry);
  writeFileSync(summariesPath, JSON.stringify(summaries, null, 2));
}

// ============================================================================
// Session Registry helpers
// ============================================================================

function getRegistryPath(workingDirectory) {
  return join(homedir(), ".claude", "projects", encodePath(workingDirectory), "session-registry.json");
}

function loadRegistry(workingDirectory) {
  const registryPath = getRegistryPath(workingDirectory);
  if (!existsSync(registryPath)) return { version: 1, sessions: [] };
  try {
    return JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch { return { version: 1, sessions: [] }; }
}

function saveRegistry(workingDirectory, registry) {
  const registryPath = getRegistryPath(workingDirectory);
  const dir = join(registryPath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

function updateSessionEntry(workingDirectory, sessionId, updates) {
  const registry = loadRegistry(workingDirectory);
  let entry = registry.sessions.find(s => s.id === sessionId);
  if (!entry) {
    entry = {
      id: sessionId,
      title: "",
      status: "in_progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: "haiku",
      messageCount: 0,
      files: [],
    };
    registry.sessions.push(entry);
  }

  if (updates.title !== undefined) entry.title = updates.title;
  if (updates.status !== undefined) entry.status = updates.status;
  if (updates.model !== undefined) entry.model = updates.model;
  if (updates.messageCount !== undefined) entry.messageCount = updates.messageCount;
  if (updates.updatedAt !== undefined) entry.updatedAt = updates.updatedAt;

  // Merge files (deduplicate)
  if (updates.files && updates.files.length > 0) {
    const fileSet = new Set(entry.files);
    for (const f of updates.files) {
      if (f) fileSet.add(f);
    }
    entry.files = [...fileSet];
  }

  saveRegistry(workingDirectory, registry);
  return entry;
}

/** Collect vault-relative file paths from chat request body */
function collectFilePaths(body) {
  const paths = [];
  if (body.activeFile?.path) paths.push(body.activeFile.path);
  if (body.mentionedFiles) {
    for (const f of body.mentionedFiles) {
      if (f.path) paths.push(f.path);
    }
  }
  if (body.relevantNotes) {
    for (const n of body.relevantNotes) {
      if (n.path) paths.push(n.path);
    }
  }
  return [...new Set(paths)];
}

/** Check if a transcript is a warmup/sidechain session that should be skipped */
function isWarmupTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return false;
  const content = readFileSync(transcriptPath, "utf-8");
  const firstLine = content.split("\n")[0];
  if (!firstLine) return false;
  try {
    const entry = JSON.parse(firstLine);
    // SDK warmup sessions have isSidechain:true and "Warmup" as first message
    if (entry.isSidechain) return true;
    const text = extractTextFromEntry(entry);
    if (text && /^warmup$/i.test(text.trim())) return true;
  } catch { /* not parseable, skip */ }
  return false;
}

/** Extract first user message title from transcript JSONL */
function extractTitleFromTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return "";
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user") {
        const text = extractTextFromEntry(entry);
        if (text && !text.startsWith("/") && !/^warmup$/i.test(text.trim())) {
          // Strip markdown, collapse whitespace, truncate to 80 chars
          const clean = text.replace(/[#*_`\[\]]/g, "").replace(/\s+/g, " ").trim();
          return clean.slice(0, 80);
        }
      }
    } catch { /* skip malformed */ }
  }
  return "";
}

/** Extract file paths from system prompts in transcript (for migration) */
function extractFilePathsFromTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const content = readFileSync(transcriptPath, "utf-8");
  const paths = new Set();
  // Match "currently viewing: **path**" patterns
  const viewingRegex = /currently viewing:\s*\*\*([^*]+)\*\*/gi;
  let match;
  while ((match = viewingRegex.exec(content)) !== null) {
    paths.add(match[1].trim());
  }
  return [...paths];
}

/** Count messages in a transcript */
function countTranscriptMessages(transcriptPath) {
  if (!existsSync(transcriptPath)) return 0;
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" || entry.type === "assistant") count++;
    } catch { /* skip */ }
  }
  return count;
}

/** Get first and last timestamps from transcript */
function getTranscriptTimestamps(transcriptPath) {
  if (!existsSync(transcriptPath)) return { first: Date.now(), last: Date.now() };
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  let first = Date.now();
  let last = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        if (entry.timestamp < first) first = entry.timestamp;
        if (entry.timestamp > last) last = entry.timestamp;
      }
    } catch { /* skip */ }
  }
  return { first, last: last || first };
}

// ============================================================================
// Express app
// ============================================================================

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
 * List sessions from registry
 * Query params: workingDirectory (required), status (optional: "in_progress"|"done"), file (optional: vault-relative path)
 */
app.get("/sessions", (req, res) => {
  const { workingDirectory, status, file } = req.query;

  if (!workingDirectory) {
    return res.status(400).json({ error: "workingDirectory is required" });
  }

  try {
    const registry = loadRegistry(workingDirectory);
    let sessions = registry.sessions;

    if (status && status !== "all") {
      sessions = sessions.filter(s => s.status === status);
    }

    if (file) {
      sessions = sessions.filter(s => s.files.includes(file));
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    res.json({ sessions });
  } catch (error) {
    logError("[Proxy] Error listing sessions:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a session entry (status, title)
 */
app.patch("/sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const { workingDirectory, status, title } = req.body;

  if (!workingDirectory) {
    return res.status(400).json({ error: "workingDirectory is required" });
  }

  try {
    const updates = { updatedAt: Date.now() };
    if (status !== undefined) updates.status = status;
    if (title !== undefined) updates.title = title;

    const entry = updateSessionEntry(workingDirectory, sessionId, updates);
    res.json({ session: entry });
  } catch (error) {
    logError("[Proxy] Error updating session:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Migrate: scan all JSONL files to populate registry
 */
app.post("/sessions/migrate", (req, res) => {
  const { workingDirectory } = req.body;

  if (!workingDirectory) {
    return res.status(400).json({ error: "workingDirectory is required" });
  }

  try {
    const projectDir = join(homedir(), ".claude", "projects", encodePath(workingDirectory));
    if (!existsSync(projectDir)) {
      return res.json({ migrated: 0 });
    }

    const registry = loadRegistry(workingDirectory);
    const existingIds = new Set(registry.sessions.map(s => s.id));

    const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
    let migrated = 0;

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      // Skip summaries sidecars
      if (sessionId.endsWith(".summaries")) continue;
      // Skip already registered
      if (existingIds.has(sessionId)) continue;

      const transcriptPath = join(projectDir, file);

      // Skip empty files
      try {
        const stat = statSync(transcriptPath);
        if (stat.size === 0) continue;
      } catch { continue; }

      // Skip warmup/sidechain sessions
      if (isWarmupTranscript(transcriptPath)) continue;

      const title = extractTitleFromTranscript(transcriptPath);
      if (!title) continue; // Skip sessions with no user messages

      const messageCount = countTranscriptMessages(transcriptPath);
      const { first, last } = getTranscriptTimestamps(transcriptPath);
      const filePaths = extractFilePathsFromTranscript(transcriptPath);

      registry.sessions.push({
        id: sessionId,
        title,
        status: "done", // Assume migrated sessions are done
        createdAt: first,
        updatedAt: last,
        model: "haiku", // Default; we can't reliably determine from transcript
        messageCount,
        files: filePaths,
      });
      migrated++;
    }

    saveRegistry(workingDirectory, registry);
    log(`[Proxy] Migration complete: ${migrated} sessions migrated`);
    res.json({ migrated });
  } catch (error) {
    logError("[Proxy] Migration error:", error);
    res.status(500).json({ error: error.message });
  }
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
    const transcriptPath = getTranscriptPath(workingDirectory, sessionId);

    if (!existsSync(transcriptPath)) {
      log("[Proxy] Transcript file not found at:", transcriptPath);
      return res.json({ messages: [] });
    }

    log("[Proxy] Reading transcript from:", transcriptPath);

    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    const messages = [];
    let captureNextUserForBoundary = false;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === "system" && entry.subtype === "compact_boundary") {
          messages.push({
            role: "compact_boundary",
            content: "",
            timestamp: entry.timestamp || Date.now(),
            compactMetadata: {
              preTokens: entry.compact_metadata?.pre_tokens || 0,
              trigger: entry.compact_metadata?.trigger || "manual",
            },
          });
          // The SDK injects a synthetic user message after compact_boundary
          // containing its internal context summary — capture it for the boundary UI
          captureNextUserForBoundary = true;
        } else if (entry.type === "user" || entry.type === "assistant") {
          if (captureNextUserForBoundary && entry.type === "user") {
            captureNextUserForBoundary = false;
            const textContent = extractTextFromEntry(entry);
            if (textContent) {
              // Attach to the most recent compact_boundary
              const lastBoundary = messages.findLast(m => m.role === "compact_boundary");
              if (lastBoundary) {
                lastBoundary.compactMetadata.sdkSummary = textContent;
              }
            }
            continue;
          }
          captureNextUserForBoundary = false;
          const textContent = extractTextFromEntry(entry);
          if (!textContent) continue;

          // Filter out compaction artifacts from transcript
          if (entry.type === "user" && /^\/compact\b/.test(textContent.trim())) continue;
          if (entry.type === "assistant" && /^compacted$/i.test(textContent.trim())) continue;
          // Skip system-injected local-command caveats
          if (textContent.includes("<local-command-caveat>")) continue;

          messages.push({
            role: entry.type,
            content: textContent,
            timestamp: entry.timestamp || Date.now(),
          });
        }
      } catch (parseError) {
        // Skip malformed lines
        log("[Proxy] Skipping malformed line");
      }
    }

    // Attach saved summaries to compact_boundary entries
    const summariesPath = getSummariesPath(workingDirectory, sessionId);
    const summaries = loadSummaries(summariesPath);
    let summaryIdx = 0;
    for (const msg of messages) {
      if (msg.role === "compact_boundary" && summaryIdx < summaries.length) {
        msg.compactMetadata.summary = summaries[summaryIdx].summary;
        summaryIdx++;
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

  // Track the resolved session ID (set in runQuery, used in finally for registry update)
  let resolvedSessionId = sessionId || null;

  const buildQueryOptions = (resumeSessionId) => ({
    model: model || "haiku",
    systemPrompt: buildSystemPrompt(),
    permissionMode: "bypassPermissions",
    maxTurns: 100,
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
            resolvedSessionId = msg.session_id;
            log("[Proxy] Session ID:", currentSessionId);
            sendEvent("session", { sessionId: currentSessionId });
          }
          // Forward compact boundary events to client (with synthetic summary)
          if (msg.subtype === "compact_boundary") {
            log("[Proxy] Compact boundary:", msg.compact_metadata);
            const preTokens = msg.compact_metadata?.pre_tokens || 0;
            const trigger = msg.compact_metadata?.trigger || "manual";

            // Generate synthetic summary from the compacted segment
            const transcriptPath = getTranscriptPath(workingDirectory, currentSessionId);
            const segmentMessages = readLatestSegmentMessages(transcriptPath);
            const summary = await generateCompactSummary(segmentMessages);

            // Persist summary to sidecar file
            if (summary && currentSessionId) {
              const summariesPath = getSummariesPath(workingDirectory, currentSessionId);
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
    // Update session registry
    try {
      if (resolvedSessionId && workingDirectory) {
        const filePaths = collectFilePaths(req.body);
        const transcriptPath = getTranscriptPath(workingDirectory, resolvedSessionId);
        const title = extractTitleFromTranscript(transcriptPath);
        const msgCount = countTranscriptMessages(transcriptPath);

        updateSessionEntry(workingDirectory, resolvedSessionId, {
          title: title || undefined,
          model: model || "haiku",
          messageCount: msgCount,
          updatedAt: Date.now(),
          files: filePaths,
        });
      }
    } catch (regError) {
      logError("[Proxy] Failed to update session registry:", regError);
    }
    res.end();
  }
});

app.listen(PORT, () => {
  log(`[Claude Agent Proxy] Running on http://localhost:${PORT}`);
  log(`[Claude Agent Proxy] Health check: http://localhost:${PORT}/health`);
});
