/**
 * Jotai state for semantic graph view
 */

import { atom } from "jotai";
import type { GraphData, GraphViewSettings, PinnedNodeConfig } from "@/types";
import { DEFAULT_GRAPH_VIEW_SETTINGS } from "@/types";
import { chatStore } from "./chatState";

// Graph data (nodes + edges)
export const graphDataAtom = atom<GraphData | null>(null);

// Graph settings
export const graphSettingsAtom = atom<GraphViewSettings>(DEFAULT_GRAPH_VIEW_SETTINGS);

// Loading state
export const isGraphLoadingAtom = atom<boolean>(false);

// Error state
export const graphErrorAtom = atom<string | null>(null);

// Whether copilot index is available for similarity edges
export const graphIndexAvailableAtom = atom<boolean>(false);

// Actions
export function setGraphData(data: GraphData | null): void {
  chatStore.set(graphDataAtom, data);
}

export function setGraphSettings(settings: GraphViewSettings): void {
  chatStore.set(graphSettingsAtom, settings);
}

export function updateGraphSettings(partial: Partial<GraphViewSettings>): void {
  const current = chatStore.get(graphSettingsAtom);
  chatStore.set(graphSettingsAtom, { ...current, ...partial });
}

export function setGraphLoading(loading: boolean): void {
  chatStore.set(isGraphLoadingAtom, loading);
}

export function setGraphError(error: string | null): void {
  chatStore.set(graphErrorAtom, error);
}

export function setGraphIndexAvailable(available: boolean): void {
  chatStore.set(graphIndexAvailableAtom, available);
}

export function togglePinnedNode(path: string): void {
  const current = chatStore.get(graphSettingsAtom);
  const exists = current.pinnedNodes.some((p) => p.path === path);
  const pinnedNodes = exists
    ? current.pinnedNodes.filter((p) => p.path !== path)
    : [...current.pinnedNodes, { path }];
  chatStore.set(graphSettingsAtom, { ...current, pinnedNodes });
}

export function updatePinnedNodeConfig(path: string, update: Partial<PinnedNodeConfig>): void {
  const current = chatStore.get(graphSettingsAtom);
  const pinnedNodes = current.pinnedNodes.map((p) =>
    p.path === path ? { ...p, ...update } : p,
  );
  chatStore.set(graphSettingsAtom, { ...current, pinnedNodes });
}
