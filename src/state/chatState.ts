import { atom, createStore } from "jotai";
import { ChatMessage, ClaudeModel } from "@/types";

// Create a dedicated store for the chat state
export const chatStore = createStore();

// Messages atom
export const messagesAtom = atom<ChatMessage[]>([]);

// Model atom (for keyboard shortcut sync)
export const modelAtom = atom<ClaudeModel>("haiku");

// Loading state atom
export const isLoadingAtom = atom<boolean>(false);

// Current streaming message atom
export const streamingMessageAtom = atom<string>("");

// Error message atom
export const errorAtom = atom<string | null>(null);

// Helper function to generate unique message IDs
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Actions
export function addMessage(message: ChatMessage): void {
  const currentMessages = chatStore.get(messagesAtom);
  chatStore.set(messagesAtom, [...currentMessages, message]);
}

export function updateStreamingMessage(content: string): void {
  chatStore.set(streamingMessageAtom, content);
}

export function clearStreamingMessage(): void {
  chatStore.set(streamingMessageAtom, "");
}

export function setLoading(loading: boolean): void {
  chatStore.set(isLoadingAtom, loading);
}

export function setError(error: string | null): void {
  chatStore.set(errorAtom, error);
}

export function clearMessages(): void {
  chatStore.set(messagesAtom, []);
  chatStore.set(streamingMessageAtom, "");
  chatStore.set(errorAtom, null);
}

/**
 * Prepend recovered history messages to the chat
 * Used when resuming a session to restore conversation history
 */
export function prependHistoryMessages(historyMessages: ChatMessage[]): void {
  const currentMessages = chatStore.get(messagesAtom);
  chatStore.set(messagesAtom, [...historyMessages, ...currentMessages]);
}
