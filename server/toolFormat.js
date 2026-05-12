/**
 * Shared helpers for formatting tool calls and results.
 * Used by both chat.js (live streaming) and history.js (history loading).
 */

import { basename } from "path";

/**
 * Human-readable label for a tool call (shown in header).
 * Examples: "Read notes.md", "Bash: list files", "search (lance)"
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
      // MCP tools: mcp__server__tool → more readable format
      const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
      if (mcpMatch) {
        const [, server, tool] = mcpMatch;
        return formatMcpDescription(server, tool, input);
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
    default: {
      // MCP tools: format input more readably
      const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
      if (mcpMatch) {
        const [, server, tool] = mcpMatch;
        return formatMcpInput(server, tool, input);
      }
      return truncateContent(JSON.stringify(input), 500);
    }
  }
}

/**
 * Human-readable description for MCP tool calls.
 * Extracts the most meaningful parameter to show in the header.
 */
function formatMcpDescription(server, tool, input) {
  if (!input) return "";

  // Common patterns for search/query tools
  if (input.query) {
    return `"${truncateContent(input.query, 50)}"`;
  }
  if (input.search || input.searchQuery) {
    return `"${truncateContent(input.search || input.searchQuery, 50)}"`;
  }

  // Document/file operations
  if (input.id && tool.includes("get")) {
    return truncateContent(input.id, 40);
  }
  if (input.path || input.file || input.filePath) {
    const path = input.path || input.file || input.filePath;
    return basename(path);
  }

  // URL operations
  if (input.url) {
    return truncateContent(input.url, 50);
  }

  // List operations
  if (tool.includes("list") || tool.includes("recent")) {
    const limit = input.limit || input.count;
    return limit ? `limit: ${limit}` : "";
  }

  return "";
}

/**
 * Format MCP tool input for the expanded body view.
 * Shows parameters in a readable key: value format.
 */
function formatMcpInput(server, tool, input) {
  if (!input) return "";

  // For simple single-param inputs, just show the value
  const keys = Object.keys(input);
  if (keys.length === 1) {
    const value = input[keys[0]];
    if (typeof value === "string" || typeof value === "number") {
      return `${keys[0]}: ${value}`;
    }
  }

  // For complex inputs, format as readable key-value pairs
  const lines = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;

    if (typeof value === "object") {
      // Arrays and objects: compact JSON
      lines.push(`${key}: ${truncateContent(JSON.stringify(value), 200)}`);
    } else {
      lines.push(`${key}: ${truncateContent(String(value), 200)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Normalize a Read/Write/Edit `file_path` to a vault-relative path.
 *
 * Claude's SDK reports `file_path` as an absolute filesystem path. The Obsidian
 * client expects vault-relative paths for `metadataCache` lookups + wikilinks.
 * If `vaultPath` is provided and the file lives inside it, strip the prefix.
 * Otherwise return as-is (e.g., the agent reading `/etc/hosts` — out of vault).
 */
function toVaultRelative(filePath, vaultPath) {
  if (!filePath || !vaultPath) return filePath;
  // Trim trailing slash on vault for clean comparison
  const vp = vaultPath.endsWith("/") ? vaultPath.slice(0, -1) : vaultPath;
  if (filePath === vp) return "";
  if (filePath.startsWith(vp + "/")) return filePath.slice(vp.length + 1);
  return filePath;
}

/**
 * Vault-aware structured fields for Read/Write/Edit, so the client UI can
 * render wikilinks/metadata/semantic-diffs without re-parsing `input`.
 *
 * Returns an object with optional fields: { filePath, editOld, editNew, writeContent }.
 * Returns {} for tools that don't apply.
 */
export function computeToolStructured(toolName, input, vaultPath) {
  if (!input) return {};
  const fp = toVaultRelative(input.file_path, vaultPath);
  switch (toolName) {
    case "Read":
      return fp ? { filePath: fp } : {};
    case "Write":
      return {
        ...(fp ? { filePath: fp } : {}),
        ...(input.content ? { writeContent: truncateContent(input.content, 4000) } : {}),
      };
    case "Edit":
      return {
        ...(fp ? { filePath: fp } : {}),
        ...(input.old_string ? { editOld: truncateContent(input.old_string, 2000) } : {}),
        ...(input.new_string ? { editNew: truncateContent(input.new_string, 2000) } : {}),
      };
    default:
      return {};
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
