/**
 * Shared helpers for formatting tool calls and results.
 * Used by both chat.js (live streaming) and history.js (history loading).
 */

import { basename } from "path";

/**
 * Human-readable label for a tool call (shown in header).
 * Examples: "Read notes.md", "Bash: list files", "search (orama)"
 */
export function computeToolDescription(toolName, input) {
  if (!input) return toolName;

  switch (toolName) {
    case "Bash":
      return input.description || truncateContent(input.command || "", 60);
    case "Read":
      return `Read ${basename(input.file_path || "")}`;
    case "Write":
      return `Write ${basename(input.file_path || "")}`;
    case "Edit":
      return `Edit ${basename(input.file_path || "")}`;
    case "Grep":
      return `Grep "${truncateContent(input.pattern || "", 40)}"`;
    case "Glob":
      return `Glob ${truncateContent(input.pattern || "", 40)}`;
    case "WebFetch":
      return `WebFetch ${truncateContent(input.url || "", 60)}`;
    case "WebSearch":
      return `WebSearch "${truncateContent(input.query || "", 50)}"`;
    default: {
      // MCP tools: mcp__server__tool → "tool (server)"
      const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
      if (mcpMatch) {
        return `${mcpMatch[2]} (${mcpMatch[1]})`;
      }
      return toolName;
    }
  }
}

/**
 * Displayable input string for the expanded tool block body.
 */
export function formatToolInput(toolName, input) {
  if (!input) return "";

  switch (toolName) {
    case "Bash":
      return input.command || "";
    case "Read":
      return input.file_path || "";
    case "Write":
      return input.file_path || "";
    case "Edit": {
      let result = input.file_path || "";
      if (input.old_string) {
        result += `\n--- old ---\n${truncateContent(input.old_string, 200)}`;
        result += `\n--- new ---\n${truncateContent(input.new_string || "", 200)}`;
      }
      return result;
    }
    case "Grep": {
      let result = input.pattern || "";
      if (input.path) result += ` in ${input.path}`;
      if (input.glob) result += ` (${input.glob})`;
      return result;
    }
    case "Glob":
      return input.pattern || "";
    default:
      return truncateContent(JSON.stringify(input), 500);
  }
}

/**
 * Truncate text with ellipsis suffix.
 */
export function truncateContent(text, maxLen = 2000) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `... (${text.length} chars total)`;
}

/**
 * Extract displayable text + error flag from a tool result user message.
 *
 * Works with both:
 * - SDK streaming messages (msg.message.content[].tool_result)
 * - JSONL transcript entries (entry.toolUseResult + entry.message.content[].tool_result)
 *
 * @param {object} entry - The full entry/message object
 * @returns {{ text: string, isError: boolean }}
 */
export function extractToolResultContent(entry) {
  const msg = typeof entry.message === "string"
    ? JSON.parse(entry.message)
    : entry.message || {};

  // Check toolUseResult (JSONL sidecar field) for structured results
  const tur = entry.toolUseResult;
  if (tur) {
    // Bash results have stdout/stderr
    if (tur.stdout !== undefined || tur.stderr !== undefined) {
      const parts = [];
      if (tur.stdout) parts.push(tur.stdout);
      if (tur.stderr) parts.push(`STDERR: ${tur.stderr}`);
      return { text: truncateContent(parts.join("\n"), 2000), isError: !!tur.stderr && !tur.stdout };
    }
    // Read results have file.content
    if (tur.file?.content) {
      return { text: truncateContent(tur.file.content, 2000), isError: false };
    }
    // MCP results are arrays of {type, text}
    if (Array.isArray(tur)) {
      const texts = tur.filter(b => b.type === "text").map(b => b.text);
      return { text: truncateContent(texts.join("\n"), 2000), isError: false };
    }
  }

  // Fallback: extract from message.content[].tool_result
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "tool_result") {
        const isError = !!block.is_error;
        const rc = block.content;
        if (typeof rc === "string") {
          return { text: truncateContent(rc, 2000), isError };
        }
        if (Array.isArray(rc)) {
          const texts = rc.filter(b => b.type === "text").map(b => b.text);
          return { text: truncateContent(texts.join("\n"), 2000), isError };
        }
        return { text: truncateContent(String(rc || ""), 2000), isError };
      }
    }
  }

  return { text: "", isError: false };
}
