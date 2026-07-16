export interface ChatInputKeyEvent {
  key: string;
  shiftKey: boolean;
  isMobile: boolean;
  isComposing: boolean;
  keyCode: number;
}

export type ChatInputKeyAction = "ignore" | "submit" | "continue";

/**
 * Keep IME confirmation Enter separate from chat submission. keyCode 229 is
 * retained as a WebKit/Electron fallback when isComposing is cleared early.
 */
export function getChatInputKeyAction(event: ChatInputKeyEvent): ChatInputKeyAction {
  if (event.isComposing || event.keyCode === 229) return "ignore";
  if (event.key === "Enter" && !event.shiftKey && !event.isMobile) return "submit";
  return "continue";
}
