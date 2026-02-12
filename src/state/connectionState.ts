/**
 * Jotai state for connection management
 */

import { atom } from "jotai";
import type { ConnectionStatus } from "@/types";
import { chatStore } from "./chatState";

// Connection status atom
export const connectionStatusAtom = atom<ConnectionStatus>("disconnected");

// Connection error atom
export const connectionErrorAtom = atom<string | null>(null);

// Actions
export function setConnectionStatus(status: ConnectionStatus): void {
  chatStore.set(connectionStatusAtom, status);
}

export function setConnectionError(error: string | null): void {
  chatStore.set(connectionErrorAtom, error);
}
