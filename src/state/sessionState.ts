/**
 * Jotai state for session management feature
 */

import { atom } from "jotai";
import type { SessionEntry, SessionsMode, SessionStatus } from "@/types";
import { chatStore } from "./chatState";

// Session list
export const sessionsAtom = atom<SessionEntry[]>([]);

// Loading state
export const isLoadingSessionsAtom = atom<boolean>(false);

// Panel mode: "thisFile" shows sessions for active file, "all" shows everything
export const sessionsModeAtom = atom<SessionsMode>("thisFile");

// Status filter: "in_progress" or "all"
export const sessionStatusFilterAtom = atom<SessionStatus | "all">("in_progress");

// Error state
export const sessionsErrorAtom = atom<string | null>(null);

// Actions
export function setSessions(sessions: SessionEntry[]): void {
  chatStore.set(sessionsAtom, sessions);
}

export function setLoadingSessions(loading: boolean): void {
  chatStore.set(isLoadingSessionsAtom, loading);
}

export function setSessionsMode(mode: SessionsMode): void {
  chatStore.set(sessionsModeAtom, mode);
}

export function setSessionStatusFilter(filter: SessionStatus | "all"): void {
  chatStore.set(sessionStatusFilterAtom, filter);
}

export function setSessionsError(error: string | null): void {
  chatStore.set(sessionsErrorAtom, error);
}

export function clearSessions(): void {
  chatStore.set(sessionsAtom, []);
  chatStore.set(sessionsErrorAtom, null);
}
