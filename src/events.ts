const EVENT_PREFIX = "hermes-agent";

export const AGENT_EVENTS = {
  addNoteToChat: `${EVENT_PREFIX}:add-note-to-chat`,
  explainFlashcard: `${EVENT_PREFIX}:explain-flashcard`,
  focusInput: `${EVENT_PREFIX}:focus-input`,
  openFile: `${EVENT_PREFIX}:open-file`,
  openModelSelector: `${EVENT_PREFIX}:open-model-selector`,
  openSessionSwitcher: `${EVENT_PREFIX}:open-session-switcher`,
  refreshSessions: `${EVENT_PREFIX}:refresh-sessions`,
  relocateView: `${EVENT_PREFIX}:relocate-view`,
  scrollToFlashcard: `${EVENT_PREFIX}:scroll-to-flashcard`,
  sendMessage: `${EVENT_PREFIX}:send-message`,
  sessionChanged: `${EVENT_PREFIX}:session-changed`,
  sessionDeleted: `${EVENT_PREFIX}:session-deleted`,
  switchSession: `${EVENT_PREFIX}:switch-session`,
  switchSessionDone: `${EVENT_PREFIX}:switch-session-done`,
} as const;
