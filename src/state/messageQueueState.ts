import { atom } from "jotai";
import { chatStore } from "./chatState";

export interface QueuedMessage {
  id: string;
  content: string;
  status: "pending" | "injecting" | "injected" | "failed";
  timestamp: number;
}

export const messageQueueAtom = atom<QueuedMessage[]>([]);

export function addToQueue(content: string): string {
  const id = `queue_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const current = chatStore.get(messageQueueAtom);
  chatStore.set(messageQueueAtom, [
    ...current,
    { id, content, status: "pending", timestamp: Date.now() },
  ]);
  return id;
}

export function updateQueueStatus(id: string, status: QueuedMessage["status"]): void {
  const current = chatStore.get(messageQueueAtom);
  chatStore.set(
    messageQueueAtom,
    current.map((m) => (m.id === id ? { ...m, status } : m))
  );
}

export function removeFromQueue(id: string): void {
  const current = chatStore.get(messageQueueAtom);
  chatStore.set(
    messageQueueAtom,
    current.filter((m) => m.id !== id)
  );
}

export function clearQueue(): void {
  chatStore.set(messageQueueAtom, []);
}
