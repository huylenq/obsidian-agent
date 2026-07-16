import { ToolBlock } from "@/types";

export type ToolStatus = "running" | "error" | "done";

const MCP_REGEX = /^mcp__([^_]+)__(.+)$/;

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const m = name.match(MCP_REGEX);
  return m ? { server: m[1], tool: m[2] } : null;
}

// Friendly names for MCP tool calls — the bold label shown in the header.
// Keys are `${server}/${tool}`. Fallback derives from the tool name itself.
const MCP_NICE_NAMES: Record<string, string> = {
  "lance/search": "Semantic search",
  "lance/list_recent": "Recent notes",
  "lance/search_by_path": "Path search",
  "orama/search": "Semantic search",
  "orama/list_recent": "Recent notes",
  "orama/get_document": "Get document",
  "context7/resolve-library-id": "Resolve library",
  "context7/get-library-docs": "Library docs",
  "plugin_context7_context7/resolve-library-id": "Resolve library",
  "plugin_context7_context7/query-docs": "Library docs",
  "things/get-today": "Today's tasks",
  "things/search-todos": "Todo search",
  "things/search-advanced": "Advanced todo search",
  "things/get-projects": "Things projects",
  "Readwise/search_readwise_highlights": "Readwise search",
  "karakeep/search-bookmarks": "Bookmark search",
  "karakeep/get-bookmark-content": "Bookmark content",
  "wikipedia/search_wikipedia": "Wikipedia search",
  "wikipedia/get_summary": "Wikipedia summary",
  "chrome-devtools/click": "Chrome click",
  "chrome-devtools/navigate_page": "Chrome navigate",
  "chrome-devtools/take_screenshot": "Chrome screenshot",
  "nano-banana-raycast/generate_image": "Generate image",
  "nano-banana-raycast/list_images": "List images",
};

function deriveMcpNiceName(server: string, tool: string): string {
  const titled = tool.replace(/[-_]+/g, " ").trim();
  return titled.charAt(0).toUpperCase() + titled.slice(1) + ` (${server})`;
}

export function getMcpNiceName(server: string, tool: string): string {
  return MCP_NICE_NAMES[`${server}/${tool}`] ?? deriveMcpNiceName(server, tool);
}

export function displayToolName(name: string): string {
  const mcp = parseMcpToolName(name);
  return mcp ? getMcpNiceName(mcp.server, mcp.tool) : name;
}

export function getBlockStatus(block: ToolBlock): ToolStatus {
  if (block.isError) return "error";
  if (block.isRunning) return "running";
  return "done";
}

export interface GroupInspection {
  status: ToolStatus;
  runningBlock: ToolBlock | null;
  errorBlock: ToolBlock | null;
}

export function inspectGroup(blocks: ToolBlock[]): GroupInspection {
  let runningBlock: ToolBlock | null = null;
  let errorBlock: ToolBlock | null = null;
  for (const b of blocks) {
    if (b.isError && !errorBlock) errorBlock = b;
    else if (b.isRunning && !runningBlock) runningBlock = b;
  }
  // Active work owns the header state. Historical failures stay visible in
  // their rows, but must not recolor and pulse a later retry/current tool red.
  const status: ToolStatus = runningBlock ? "running" : errorBlock ? "error" : "done";
  return { status, runningBlock, errorBlock };
}

// Lucide icon names (shipped with Obsidian via `setIcon`).
const BUILTIN_ICONS: Record<string, string> = {
  Read: "file-text",
  Write: "file-plus-2",
  Edit: "pencil",
  MultiEdit: "file-pen-line",
  Bash: "terminal",
  Glob: "search",
  Grep: "search-code",
  Task: "bot",
  Agent: "bot",
  WebFetch: "link",
  WebSearch: "globe",
  TodoWrite: "list-checks",
  NotebookEdit: "notebook-pen",
  Skill: "sparkles",
  ToolSearch: "binoculars",
  ListMcpResourcesTool: "boxes",
  ReadMcpResourceTool: "boxes",
};

// Per-MCP-server icon (one icon represents the whole server).
const MCP_SERVER_ICONS: Record<string, string> = {
  lance: "database",
  orama: "database",
  "chrome-devtools": "chrome",
  "nano-banana-raycast": "image",
  context7: "library",
  things: "list-todo",
  Readwise: "book-marked",
  karakeep: "bookmark",
  wikipedia: "book-open",
};

const FALLBACK_ICON = "wrench";
const MCP_FALLBACK_ICON = "plug";

export function getToolIcon(toolName: string): string {
  const mcp = parseMcpToolName(toolName);
  if (mcp) return MCP_SERVER_ICONS[mcp.server] ?? MCP_FALLBACK_ICON;
  return BUILTIN_ICONS[toolName] ?? FALLBACK_ICON;
}

// One icon per block — no deduplication. Stacked overlap conveys count visually,
// the right-docked total chip gives the exact number.
export interface BlockIcon {
  key: string;     // toolUseId
  label: string;   // human label for tooltip
  icon: string;    // lucide id
}

// Verb summary for completed tool groups: "Read 14 files · Ran 2 commands"
const VERBS: Record<string, { verb: string; noun: string; nounPlural: string }> = {
  Read: { verb: "Read", noun: "file", nounPlural: "files" },
  Write: { verb: "Wrote", noun: "file", nounPlural: "files" },
  Edit: { verb: "Edited", noun: "file", nounPlural: "files" },
  MultiEdit: { verb: "Edited", noun: "file", nounPlural: "files" },
  Bash: { verb: "Ran", noun: "command", nounPlural: "commands" },
  Glob: { verb: "Globbed", noun: "pattern", nounPlural: "patterns" },
  Grep: { verb: "Searched", noun: "pattern", nounPlural: "patterns" },
  Task: { verb: "Delegated", noun: "task", nounPlural: "tasks" },
  Agent: { verb: "Delegated", noun: "task", nounPlural: "tasks" },
  WebFetch: { verb: "Fetched", noun: "URL", nounPlural: "URLs" },
  WebSearch: { verb: "Searched", noun: "query", nounPlural: "queries" },
  TodoWrite: { verb: "Updated", noun: "todo", nounPlural: "todos" },
};

/** Tool names that operate on a single vault file path. */
export type FileToolName = "Read" | "Write" | "Edit" | "MultiEdit";

// Tools whose count + icon should dedupe by `filePath` rather than per-call.
// Five edits to one file = one icon and "Edited 1 file" — not "Edited 5 files".
export const FILE_TOOLS_DEDUPE: ReadonlySet<FileToolName> = new Set([
  "Read", "Write", "Edit", "MultiEdit",
]);

export function isFileTool(name: string): name is FileToolName {
  return (FILE_TOOLS_DEDUPE as ReadonlySet<string>).has(name);
}

// Caption segments — counts are flagged so they can render bold inline.
export type SummaryPart = { text: string; bold?: boolean };

export function summarizeBlocks(blocks: ToolBlock[]): SummaryPart[] {
  // For file-tools, count distinct paths (not block instances). Non-file tools
  // count per call as before. Track unique (toolName, filePath) tuples in a set;
  // for everything else just increment.
  const counts = new Map<string, number>();
  const seenFile = new Map<string, Set<string>>();
  for (const b of blocks) {
    if (b.filePath && isFileTool(b.toolName)) {
      let set = seenFile.get(b.toolName);
      if (!set) { set = new Set(); seenFile.set(b.toolName, set); }
      if (set.has(b.filePath)) continue;
      set.add(b.filePath);
    }
    counts.set(b.toolName, (counts.get(b.toolName) ?? 0) + 1);
  }
  const result: SummaryPart[] = [];
  let first = true;
  for (const [toolName, count] of counts) {
    if (!first) result.push({ text: " · " });
    first = false;
    const mcp = parseMcpToolName(toolName);
    if (mcp) {
      const name = getMcpNiceName(mcp.server, mcp.tool);
      if (count > 1) {
        result.push({ text: `${name} ×` });
        result.push({ text: String(count), bold: true });
      } else {
        result.push({ text: name });
      }
      continue;
    }
    const v = VERBS[toolName];
    if (v) {
      result.push({ text: `${v.verb} ` });
      result.push({ text: String(count), bold: true });
      result.push({ text: ` ${count === 1 ? v.noun : v.nounPlural}` });
    } else {
      result.push({ text: `${toolName} ×` });
      result.push({ text: String(count), bold: true });
    }
  }
  return result;
}

export function getBlockIcons(blocks: ToolBlock[]): BlockIcon[] {
  // Same dedup rule as the caption: collapse repeat file-tool icons by
  // (toolName, filePath) so 5 edits to one file render as one icon.
  const seen = new Set<string>();
  const out: BlockIcon[] = [];
  for (const b of blocks) {
    if (b.filePath && isFileTool(b.toolName)) {
      const key = `${b.toolName}::${b.filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const mcp = parseMcpToolName(b.toolName);
    out.push({
      key: b.toolUseId,
      label: mcp ? `${mcp.server}/${mcp.tool}` : b.toolName,
      icon: getToolIcon(b.toolName),
    });
  }
  return out;
}
