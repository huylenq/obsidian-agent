export interface CompactMetadata {
  preTokens: number;
  trigger: "manual" | "auto";
  summary?: string;
  sdkSummary?: string;
}

export interface ToolBlock {
  toolUseId: string;
  toolName: string;
  description: string;
  input?: string;
  output?: string;
  isError?: boolean;
  isRunning?: boolean;
}

export interface MarkerMetadata {
  markerId: string;
  flashcardId: string;    // cardId from deeplink
  sourceFile: string;     // vault-relative path
  question: string;       // card front (for display)
}

export interface ImageAttachment {
  data: string;        // base64-encoded image data (no data: prefix)
  mediaType: string;   // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  name?: string;       // original filename if from vault
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "tool_block" | "compact_boundary";
  content: string;
  timestamp: number;
  toolName?: string;
  toolBlocks?: ToolBlock[];
  compactMetadata?: CompactMetadata;
  markerMetadata?: MarkerMetadata;
  images?: ImageAttachment[];
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

export type ChatViewLocation = "sidebar" | "tab";

export type ConnectionMode = "local" | "remote";
export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "error";

export interface GraphViewSettings {
  linkDepth: 1 | 2 | 3;
  similarityThreshold: number;   // default 0.4
  maxSimilarityEdges: number;    // default 15
  showLinkEdges: boolean;
  showSimilarityEdges: boolean;
  // Physics / force settings
  centerForce: number;           // 0..1, default 0.5
  repelForce: number;            // 0..500, default 100 (applied as negative internally)
  linkDistance: number;           // 50..500, default 250
  // UI
  floatSliders: boolean;         // undock filter sliders to HUD overlay
  // Pinned nodes — persist across center changes
  pinnedNodes: PinnedNodeConfig[];
}

export const DEFAULT_GRAPH_VIEW_SETTINGS: GraphViewSettings = {
  linkDepth: 1,
  similarityThreshold: 0.4,
  maxSimilarityEdges: 15,
  showLinkEdges: true,
  showSimilarityEdges: true,
  centerForce: 0.5,
  repelForce: 100,
  linkDistance: 250,
  floatSliders: false,
  pinnedNodes: [],
};

export interface ClaudeAgentSettings {
  systemPrompt: string;
  showDebugInfo: boolean;
  sessionId: string | null;
  model: ClaudeModel;
  includeRelevantNotes: boolean;
  graphSettings: GraphViewSettings;
  connectionMode: ConnectionMode;
  remoteServerUrl: string;
  remoteAuthToken: string;
  chatViewLocation: ChatViewLocation;
}

export const DEFAULT_SETTINGS: ClaudeAgentSettings = {
  systemPrompt: `You are a helpful assistant that answers questions about the user's Obsidian vault.
Use the available MCP tools to search and read notes when needed.
Be concise and accurate.`,
  showDebugInfo: false,
  sessionId: null,
  model: "haiku",
  includeRelevantNotes: true,
  graphSettings: DEFAULT_GRAPH_VIEW_SETTINGS,
  connectionMode: "local",
  remoteServerUrl: "",
  remoteAuthToken: "",
  chatViewLocation: "sidebar",
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

// ============================================================================
// Session Management Types
// ============================================================================

export type SessionStatus = "in_progress" | "done";

export type SessionsMode = "thisFile" | "all";

export type SessionType = "regular" | "flashcard_study";

export interface SessionEntry {
  id: string;
  title: string;                // first user message, 80 chars max
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  model: ClaudeModel;
  messageCount: number;
  files: string[];              // vault-relative note paths (deduped)
  type?: SessionType;           // undefined = regular (backcompat)
  epoch?: string;               // "2026-02-15" for daily flashcard sessions
}

export interface SessionRegistry {
  version: 1;
  sessions: SessionEntry[];
}

// ============================================================================
// Semantic Graph View Types
// ============================================================================

export interface PinnedNodeConfig {
  path: string;                    // vault-relative path (= GraphNode.id)
  linkDepth?: 1 | 2 | 3;          // undefined = use global
  similarityThreshold?: number;    // undefined = use global
}

export interface GraphNode {
  id: string;              // vault-relative path
  title: string;           // filename sans extension
  depth: number;           // BFS depth from center (0 = active file)
  isCenter: boolean;
  isPinned?: boolean;
  pinnedConfig?: PinnedNodeConfig;
  inVectorIndex: boolean;
  x?: number; y?: number;  // d3-force mutates these
  fx?: number | null;      // fixed position (center node pinned)
  fy?: number | null;
}

export interface GraphEdge {
  id: string;              // `${source}--${type}--${target}`
  source: string | GraphNode;
  target: string | GraphNode;
  type: "link" | "similarity";
  direction: "outgoing" | "incoming" | "bidirectional";
  weight: number;          // similarity score for similarity edges, 1.0 for links
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  centerPath: string;
}

