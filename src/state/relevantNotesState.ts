/**
 * Jotai state for relevant notes feature
 */

import { atom } from "jotai";
import type { RankedNote, SearchMode } from "@/types";
import { chatStore } from "./chatState";

// Relevant notes results
export const relevantNotesAtom = atom<RankedNote[]>([]);

// Current search mode
export const searchModeAtom = atom<SearchMode>("currentFile");

// Loading state for relevant notes search
export const isSearchingNotesAtom = atom<boolean>(false);

// Index availability state
export const indexAvailableAtom = atom<boolean>(false);

// Error state for relevant notes
export const relevantNotesErrorAtom = atom<string | null>(null);

// Whether to include relevant notes in prompt context (checkbox state)
export const includeRelevantNotesAtom = atom<boolean>(true);

// Actions
export function setRelevantNotes(notes: RankedNote[]): void {
  chatStore.set(relevantNotesAtom, notes);
}

export function setSearchMode(mode: SearchMode): void {
  chatStore.set(searchModeAtom, mode);
}

export function setSearchingNotes(searching: boolean): void {
  chatStore.set(isSearchingNotesAtom, searching);
}

export function setIndexAvailable(available: boolean): void {
  chatStore.set(indexAvailableAtom, available);
}

export function setRelevantNotesError(error: string | null): void {
  chatStore.set(relevantNotesErrorAtom, error);
}

export function clearRelevantNotes(): void {
  chatStore.set(relevantNotesAtom, []);
  chatStore.set(relevantNotesErrorAtom, null);
}

export function setIncludeRelevantNotes(enabled: boolean): void {
  chatStore.set(includeRelevantNotesAtom, enabled);
}
