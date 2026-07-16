/**
 * Persisted identifiers from releases before the Hermes ACP migration.
 * Keep compatibility-only names isolated here; new code uses Hermes naming.
 */
export const LEGACY_CONNECTION_FILE = "claude-agent-connection.json";

export const LEGACY_COMMAND_IDS = {
  openChat: "open-claude-agent-chat",
  newChat: "new-claude-agent-chat",
} as const;

export const LEGACY_VIEW_TYPES = {
  chat: "claude-agent-chat",
  relevantNotes: "claude-agent-relevant-notes",
  sessions: "claude-agent-sessions",
  graph: "claude-agent-semantic-graph",
} as const;

export const LEGACY_EVENTS = {
  explainFlashcard: "claude-agent:explain-flashcard",
} as const;

export const LEGACY_SETTING_KEYS = {
  remoteBridgeUrl: "remoteServerUrl",
} as const;
