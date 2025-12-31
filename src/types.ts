export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
}

export interface ActiveFileContext {
  path: string;      // Relative path from vault root
  name: string;      // Filename with extension
  extension: string; // File extension (e.g., "md")
}

export interface SelectionContext {
  text: string;       // The selected text content
  filePath: string;   // Path of file containing selection
  fileName: string;   // Name of file containing selection
  startLine?: number; // Line where selection starts (1-indexed)
  endLine?: number;   // Line where selection ends (1-indexed)
}

export type ClaudeModel = "haiku" | "sonnet" | "opus";

export interface ClaudeAgentSettings {
  systemPrompt: string;
  showDebugInfo: boolean;
  sessionId: string | null;
  model: ClaudeModel;
}

export const DEFAULT_SETTINGS: ClaudeAgentSettings = {
  systemPrompt: `You are a helpful assistant that answers questions about the user's Obsidian vault.
Use the available MCP tools to search and read notes when needed.
Be concise and accurate.`,
  showDebugInfo: false,
  sessionId: null,
  model: "haiku",
};
