import crypto from "crypto";
import { hermesAcpClient } from "./hermesAcpClient.js";
import { logError } from "./log.js";
import { appendTranscriptEntry, getTranscriptPath } from "./transcript.js";
import {
  updateSessionEntry,
  collectFilePaths,
  extractTitleFromTranscript,
  countTranscriptMessages,
  countUserOnlyMessages,
} from "./sessions.js";
import { getMarkersPath, appendMarker } from "./markers.js";
import { appendTouched } from "./touchedNotes.js";
import {
  computeToolDescription,
  computeToolStructured,
  formatToolInput,
} from "./toolFormat.js";

const TOUCH_OP_BY_TOOL = { Read: "read", Write: "write", Edit: "edit" };

function wrapWithSelection(text, selection) {
  if (!selection?.text) return text;
  const lineAttr = selection.startLine
    ? selection.startLine === selection.endLine
      ? ` lines="${selection.startLine}"`
      : ` lines="${selection.startLine}-${selection.endLine}"`
    : "";
  return `<selected-text file="${selection.filePath}"${lineAttr}>\n${selection.text}\n</selected-text>\n\n${text || ""}`;
}

function buildAgentText({ message, systemPrompt, activeFile, mentionedFiles, selection, relevantNotes }) {
  const instructions = systemPrompt || `You are a helpful assistant that answers questions about the user's Obsidian vault.
Use the available tools to search and read notes when needed.
Be concise and accurate.`;

  const context = [
    "## Obsidian agent instructions",
    instructions,
    "",
    "When creating a diagram, use a fenced Graphviz DOT code block rather than ASCII art.",
  ];

  if (activeFile) {
    context.push("", "## Current context", `The user is currently viewing: **${activeFile.path}**`);
  }
  if (mentionedFiles?.length) {
    context.push(
      "",
      "## Referenced files",
      ...mentionedFiles.map((file) => `- ${file.path}`),
    );
  }
  if (relevantNotes?.length) {
    context.push(
      "",
      "## Relevant notes",
      ...relevantNotes.map((note) => {
        const preview = note.content.slice(0, 200).replace(/\n/g, " ").trim();
        return `- **${note.title}** (${note.path}): ${preview}${note.content.length > 200 ? "..." : ""}`;
      }),
    );
  }

  const userText = wrapWithSelection(message, selection);
  return `<obsidian-agent-context>\n${context.join("\n")}\n</obsidian-agent-context>\n\n${userText || ""}`;
}

function buildAcpPrompt(text, images) {
  const blocks = text ? [{ type: "text", text }] : [];
  for (const image of images || []) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mediaType });
  }
  return blocks;
}

function buildTranscriptContent(text, images) {
  if (!images?.length) return text || "";
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    })),
  ];
}

function contentBlockText(block) {
  if (!block) return "";
  if (block.type === "text" || block.type === "thinking") return block.text || "";
  if (block.type === "content") return block.content?.text || "";
  if (block.type === "diff") {
    return `${block.path || ""}\n--- old ---\n${block.oldText || ""}\n--- new ---\n${block.newText || ""}`;
  }
  return "";
}

function extractContentText(content) {
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  return blocks.map(contentBlockText).filter(Boolean).join("\n");
}

function inferToolName(update) {
  const title = (update.title || "").toLowerCase();
  if (title.startsWith("read:")) return "Read";
  if (title.startsWith("write:")) return "Write";
  if (title.startsWith("patch")) return "Edit";
  if (title.startsWith("terminal:")) return "Bash";
  if (title.startsWith("search:")) return "Grep";
  if (title.startsWith("web search:")) return "WebSearch";
  if (update.kind === "read") return "Read";
  if (update.kind === "edit") return "Edit";
  if (update.kind === "execute") return "Bash";
  if (update.kind === "search") return "Grep";
  return update.title?.split(":", 1)[0] || update.kind || "Tool";
}

function buildToolInput(toolName, update) {
  const raw = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : {};
  const path = update.locations?.[0]?.path;
  const text = extractContentText(update.content);
  switch (toolName) {
    case "Read":
    case "Write":
      return { ...raw, ...(path && { file_path: path }) };
    case "Edit": {
      const diff = update.content?.find?.((block) => block.type === "diff");
      return {
        ...raw,
        ...(path && { file_path: path }),
        ...(diff?.oldText && { old_string: diff.oldText }),
        ...(diff?.newText && { new_string: diff.newText }),
      };
    }
    case "Bash":
      return { ...raw, command: raw.command || text.replace(/^\$\s*/, "") };
    default:
      return Object.keys(raw).length ? raw : { details: text || update.title || "" };
  }
}

function transcriptAssistant(text) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function transcriptToolUse(toolUseId, toolName, input) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
    },
  };
}

function transcriptToolResult(toolUseId, content, isError) {
  return {
    type: "user",
    toolUseResult: { content, isError },
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  };
}

export class ChatSession {
  constructor({ id, request, vaultPath, onEvent, acpClient = hermesAcpClient }) {
    this.id = id;
    this.request = request;
    this.vaultPath = vaultPath;
    this.onEvent = onEvent;
    this.acpClient = acpClient;
    this.resolvedSessionId = request.sessionId || null;
    this.resolvedModel = request.model || "hermes";
    this.active = true;
    this.touchedCollector = [];
    this.assistantText = "";
    this.pendingSteerAcknowledgements = [];
    this.startedAt = Date.now();
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Controls may never await readiness, so prevent an unhandled rejection if
    // opening the Hermes session fails before the first event.
    this.ready.catch(() => {});
  }

  emit(type, data = {}) {
    this.onEvent({ type, ...data });
  }

  async run() {
    const {
      message,
      systemPrompt,
      sessionId,
      activeFile,
      mentionedFiles,
      selection,
      relevantNotes,
      flashcardMeta,
      sessionMeta,
      images,
    } = this.request;

    try {
      const opened = await this.acpClient.openSession({ sessionId, cwd: this.vaultPath });
      this.resolvedSessionId = opened.sessionId;
      this.resolvedModel = opened.models?.currentModelId || this.resolvedModel;
      this.resolveReady(this.resolvedSessionId);
      this.emit("session", { sessionId: this.resolvedSessionId });

      appendTranscriptEntry(this.vaultPath, this.resolvedSessionId, {
        type: "user",
        message: { role: "user", content: buildTranscriptContent(message, images) },
      });

      // `/compact` is implemented by Hermes' ACP adapter and must remain the
      // first token of a text-only prompt. Normal turns receive Obsidian context.
      const agentText = /^\/compact(?:\s|$)/i.test(message?.trim() || "") && !images?.length
        ? message.trim()
        : buildAgentText({
            message,
            systemPrompt,
            activeFile,
            mentionedFiles,
            selection,
            relevantNotes,
          });

      const result = await this.acpClient.prompt(
        this.resolvedSessionId,
        buildAcpPrompt(agentText, images),
        (update) => this.handleUpdate(update),
      );

      if (this.assistantText) {
        appendTranscriptEntry(
          this.vaultPath,
          this.resolvedSessionId,
          transcriptAssistant(this.assistantText),
        );
      }

      if (result?.stopReason === "refusal") {
        this.emit("error", {
          content: "Hermes refused the prompt. The session may no longer exist; start a new chat.",
        });
      } else if (result?.stopReason === "cancelled") {
        this.emit("interrupted");
      } else {
        this.emit("result", {
          durationMs: Date.now() - this.startedAt,
          numTurns: 1,
          usage: result?.usage,
        });
      }
    } catch (error) {
      this.rejectReady(error);
      logError("[Hermes Bridge] ACP chat error:", error);
      this.emit("error", { content: error.message || String(error) });
    } finally {
      this.active = false;
      this.persistSession();
      this.emit("done", { sessionId: this.resolvedSessionId });
    }
  }

  handleUpdate(update) {
    switch (update?.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractContentText(update.content);
        const acknowledgementIndex = this.pendingSteerAcknowledgements.indexOf(text);
        if (acknowledgementIndex !== -1) {
          this.pendingSteerAcknowledgements.splice(acknowledgementIndex, 1);
          break;
        }
        if (text) {
          this.assistantText += text;
          this.emit("text", { content: text });
        }
        break;
      }

      case "tool_call": {
        const toolName = inferToolName(update);
        const inputObject = buildToolInput(toolName, update);
        const structured = computeToolStructured(toolName, inputObject, this.vaultPath);
        this.emit("tool_use", {
          toolName,
          toolUseId: update.toolCallId,
          description: computeToolDescription(toolName, inputObject) || update.title,
          input: formatToolInput(toolName, inputObject),
          ...structured,
        });
        appendTranscriptEntry(
          this.vaultPath,
          this.resolvedSessionId,
          transcriptToolUse(update.toolCallId, toolName, inputObject),
        );
        const op = TOUCH_OP_BY_TOOL[toolName];
        if (op && structured.filePath) {
          this.touchedCollector.push({ path: structured.filePath, op, at: Date.now() });
        }
        break;
      }

      case "tool_call_update": {
        if (!update.status || !["completed", "failed"].includes(update.status)) break;
        const content = extractContentText(update.content) || update.rawOutput || "";
        const isError = update.status === "failed";
        this.emit("tool_result", {
          toolUseId: update.toolCallId,
          content,
          isError,
        });
        appendTranscriptEntry(
          this.vaultPath,
          this.resolvedSessionId,
          transcriptToolResult(update.toolCallId, content, isError),
        );
        break;
      }
    }
  }

  async inject({ message, selection, images }) {
    if (!message && !images?.length) throw new Error("Message or images required");
    const sessionId = await this.ready;
    if (!this.active) throw new Error("Chat is no longer active");

    appendTranscriptEntry(this.vaultPath, sessionId, {
      type: "user",
      message: {
        role: "user",
        content: buildTranscriptContent(wrapWithSelection(message, selection), images),
      },
    });
    const text = wrapWithSelection(message, selection);
    const steerText = images?.length ? text : `/steer ${text}`;
    if (images?.length) {
      return this.acpClient.steer(sessionId, buildAcpPrompt(steerText, images));
    }

    const preview = text.slice(0, 80) + (text.length > 80 ? "..." : "");
    const acknowledgement = `⏩ Steer queued for the active turn: ${preview}`;
    this.pendingSteerAcknowledgements.push(acknowledgement);
    try {
      return await this.acpClient.steer(sessionId, buildAcpPrompt(steerText, images));
    } finally {
      const acknowledgementIndex = this.pendingSteerAcknowledgements.indexOf(acknowledgement);
      if (acknowledgementIndex !== -1) {
        this.pendingSteerAcknowledgements.splice(acknowledgementIndex, 1);
      }
    }
  }

  async interrupt() {
    const sessionId = await this.ready;
    if (!this.active) return false;
    this.acpClient.cancel(sessionId);
    return true;
  }

  persistSession() {
    const { message, sessionMeta, flashcardMeta } = this.request;
    try {
      if (this.resolvedSessionId) {
        const transcriptPath = getTranscriptPath(this.vaultPath, this.resolvedSessionId);
        const registryUpdates = {
          title: extractTitleFromTranscript(transcriptPath) || message?.slice(0, 80) || "Image chat",
          model: this.resolvedModel,
          messageCount: countTranscriptMessages(transcriptPath),
          files: collectFilePaths(this.request),
          updatedAt: Date.now(),
        };
        if (sessionMeta) {
          registryUpdates.type = sessionMeta.type;
          registryUpdates.epoch = sessionMeta.epoch;
        }
        updateSessionEntry(this.vaultPath, this.resolvedSessionId, registryUpdates);

        if (flashcardMeta) {
          appendMarker(getMarkersPath(this.vaultPath, this.resolvedSessionId), {
            markerId: crypto.randomUUID(),
            flashcardId: flashcardMeta.cardId,
            sourceFile: flashcardMeta.sourceFile,
            question: flashcardMeta.question,
            userMessageIndex: Math.max(0, countUserOnlyMessages(transcriptPath) - 1),
            createdAt: Date.now(),
          });
        }
      }
    } catch (registryError) {
      logError("[Hermes Bridge] Failed to update session registry:", registryError);
    }

    if (this.resolvedSessionId && this.touchedCollector.length) {
      try {
        appendTouched(this.resolvedSessionId, this.vaultPath, this.touchedCollector);
      } catch (error) {
        logError("[Hermes Bridge] Failed to update touched notes:", error);
      }
    }
  }
}
