export interface CompactMetadata {
  preTokens: number;
  trigger: "manual" | "auto";
  summary?: string;
  sdkSummary?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "compact_boundary";
  content: string;
  timestamp: number;
  toolName?: string;
  compactMetadata?: CompactMetadata;
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
  includeRelevantNotes: boolean;
}

export const DEFAULT_SETTINGS: ClaudeAgentSettings = {
  systemPrompt: `You are a helpful assistant that answers questions about the user's Obsidian vault.
Use the available MCP tools to search and read notes when needed.
Be concise and accurate.`,
  showDebugInfo: false,
  sessionId: null,
  model: "haiku",
  includeRelevantNotes: true,
};

// ============================================================================
// Relevant Notes Types (uses Copilot's existing index)
// ============================================================================

export type SearchMode = "currentFile" | "chatContext";

export type SimilarityCategory = "high" | "medium" | "low";

export interface RelevantNote {
  path: string;           // Note path in vault
  title: string;          // Note title (first H1 or filename)
  content: string;        // Preview content (truncated)
  similarity: number;     // Raw similarity score (0-1)
}

export interface RankedNote extends RelevantNote {
  finalScore: number;                // Weighted score (similarity + links)
  category: SimilarityCategory;      // high (>0.7), medium (0.55-0.7), low (<0.55)
  hasOutgoingLink?: boolean;         // Current file links to this note
  hasBacklink?: boolean;             // This note links to current file
}

export interface RelevantNotesSettings {
  enabled: boolean;
  minSimilarity: number;
  maxResults: number;
  triggerMode: SearchMode | "both";
}

export const DEFAULT_RELEVANT_NOTES_SETTINGS: RelevantNotesSettings = {
  enabled: true,
  minSimilarity: 0.4,
  maxResults: 10,
  triggerMode: "both",
};
