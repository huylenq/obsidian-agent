/**
 * Semantic Graph View — an interactive force-directed graph combining
 * wiki-link edges with embedding similarity edges.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { useAtomValue } from "jotai";
import { chatStore } from "@/state/chatState";
import {
  graphDataAtom,
  graphSettingsAtom,
  isGraphLoadingAtom,
  graphErrorAtom,
  graphIndexAvailableAtom,
  setGraphData,
  setGraphSettings,
  updateGraphSettings,
  setGraphLoading,
  setGraphError,
  setGraphIndexAvailable,
  togglePinnedNode,
  updatePinnedNodeConfig,
} from "@/state/graphViewState";
import type { GraphNode, GraphViewSettings, ActiveFileContext } from "@/types";
import { CopilotIndexReader } from "@/embeddings";
import { buildGraph } from "@/graph/buildGraph";
import { GraphCanvas } from "./GraphView/GraphCanvas";
import { GraphControls } from "./GraphView/GraphControls";
import { GraphTooltip } from "./GraphView/GraphTooltip";
import type ClaudeAgentPlugin from "@/main";

export const GRAPH_VIEW_TYPE = "claude-agent-semantic-graph";

interface GraphContainerProps {
  plugin: ClaudeAgentPlugin;
  app: App;
}

function GraphContainer({ plugin, app }: GraphContainerProps) {
  const graphData = useAtomValue(graphDataAtom, { store: chatStore });
  const settings = useAtomValue(graphSettingsAtom, { store: chatStore });
  const isLoading = useAtomValue(isGraphLoadingAtom, { store: chatStore });
  const error = useAtomValue(graphErrorAtom, { store: chatStore });
  const indexAvailable = useAtomValue(graphIndexAvailableAtom, { store: chatStore });

  const indexReaderRef = useRef<CopilotIndexReader | null>(null);
  const activeFileRef = useRef<ActiveFileContext | undefined>(undefined);
  const [activeFile, setActiveFile] = useState<ActiveFileContext | undefined>(undefined);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Initialize graph settings from persisted plugin settings
  useEffect(() => {
    setGraphSettings(plugin.settings.graphSettings);
  }, []);

  // Initialize Copilot index reader
  useEffect(() => {
    const init = async () => {
      const reader = new CopilotIndexReader(app);
      const success = await reader.initialize();
      indexReaderRef.current = reader;
      setGraphIndexAvailable(success);
    };
    init();
  }, [app]);

  // Track active file
  const getActiveFileContext = useCallback((): ActiveFileContext | undefined => {
    const file = app.workspace.getActiveFile();
    if (!file) return undefined;
    return { path: file.path, name: file.name, extension: file.extension };
  }, [app]);

  useEffect(() => {
    const update = () => {
      const next = getActiveFileContext();
      // Ignore when switching to non-file views (e.g. clicking the graph tab itself).
      // Also skip when the path hasn't actually changed to avoid re-simulation.
      if (!next) return;
      setActiveFile((prev) => prev?.path === next.path ? prev : next);
    };
    update();
    app.workspace.on("active-leaf-change", update);
    return () => { app.workspace.off("active-leaf-change", update); };
  }, [app, getActiveFileContext]);

  // Keep ref in sync with state so buildAndSetGraph always sees the latest
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  // Build graph — reads activeFile from ref, so this callback is stable (deps: [app] only).
  // Every caller always gets the current active file without stale closures.
  const buildAndSetGraph = useCallback(async () => {
    const file = activeFileRef.current;
    if (!file) return;

    setGraphLoading(true);
    setGraphError(null);

    try {
      const data = await buildGraph(
        file.path,
        app,
        indexReaderRef.current,
        chatStore.get(graphSettingsAtom),
      );
      setGraphData(data);
    } catch (err) {
      console.error("[GraphView] Error building graph:", err);
      setGraphError(err instanceof Error ? err.message : "Failed to build graph");
    } finally {
      setGraphLoading(false);
    }
  }, [app]);

  // Trigger rebuild when active file changes or index becomes available
  useEffect(() => {
    if (activeFile) buildAndSetGraph();
  }, [activeFile, indexAvailable, buildAndSetGraph]);

  // Rebuild when data-affecting settings change (not physics/force settings)
  const pinnedKey = useMemo(() => JSON.stringify(settings.pinnedNodes ?? []), [settings.pinnedNodes]);
  const dataSettingsKey = `${settings.linkDepth}|${settings.similarityThreshold}|${settings.maxSimilarityEdges}|${settings.showLinkEdges}|${settings.showSimilarityEdges}|${pinnedKey}`;
  useEffect(() => {
    if (activeFileRef.current) buildAndSetGraph();
  }, [dataSettingsKey, buildAndSetGraph]);

  // Handle node click — open the note (cmd-click or middle-click opens in new tab)
  const handleNodeClick = useCallback((node: GraphNode, newTab?: boolean) => {
    app.workspace.openLinkText(node.id, "", newTab ?? false);
  }, [app]);

  // Handle node hover
  const handleNodeHover = useCallback((node: GraphNode | null, x: number, y: number) => {
    setHoveredNode(node);
    setTooltipPos({ x, y });
  }, []);

  // Handle node right-click — add note to chat input
  const handleNodeContextMenu = useCallback((node: GraphNode) => {
    window.dispatchEvent(
      new CustomEvent("claude-agent:add-note-to-chat", { detail: { notePath: node.id } })
    );
  }, []);

  // Handle settings change from controls — update atom and persist
  const handleSettingsChange = useCallback((partial: Partial<GraphViewSettings>) => {
    updateGraphSettings(partial);
    const updated = chatStore.get(graphSettingsAtom);
    plugin.settings.graphSettings = updated;
    plugin.saveSettings();
  }, [plugin]);

  // Debounced rebuild for right-drag adjustments (depth/similarity)
  const debouncedRebuildRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRebuild = useCallback(() => {
    if (debouncedRebuildRef.current) clearTimeout(debouncedRebuildRef.current);
    debouncedRebuildRef.current = setTimeout(() => {
      buildAndSetGraph();
    }, 150);
  }, [buildAndSetGraph]);

  // Handle pin toggle — right-click on node
  // No direct buildAndSetGraph() call needed: togglePinnedNode mutates the atom →
  // settings.pinnedNodes changes → pinnedKey changes → dataSettingsKey effect fires rebuild.
  const handleNodePinToggle = useCallback((node: GraphNode) => {
    togglePinnedNode(node.id);
    const updated = chatStore.get(graphSettingsAtom);
    plugin.settings.graphSettings = updated;
    plugin.saveSettings();
  }, [plugin]);

  // Handle right-drag depth adjustment on pinned node
  // Reads from atom store directly to avoid stale settings closure
  const handleNodeDepthAdjust = useCallback((node: GraphNode, deltaPixels: number) => {
    if (!node.isPinned) return;
    const s = chatStore.get(graphSettingsAtom);
    const currentConfig = (s.pinnedNodes ?? []).find((p) => p.path === node.id);
    const currentDepth = currentConfig?.linkDepth ?? s.linkDepth;
    const steps = Math.round(deltaPixels / 40);
    const newDepth = Math.max(1, Math.min(3, currentDepth + steps)) as 1 | 2 | 3;
    if (newDepth === currentConfig?.linkDepth) return;
    updatePinnedNodeConfig(node.id, { linkDepth: newDepth });
    const updated = chatStore.get(graphSettingsAtom);
    plugin.settings.graphSettings = updated;
    plugin.saveSettings();
    debouncedRebuild();
  }, [plugin, debouncedRebuild]);

  // Handle alt+right-drag similarity adjustment on pinned node
  const handleNodeSimilarityAdjust = useCallback((node: GraphNode, deltaPixels: number) => {
    if (!node.isPinned) return;
    const s = chatStore.get(graphSettingsAtom);
    const currentConfig = (s.pinnedNodes ?? []).find((p) => p.path === node.id);
    const currentThreshold = currentConfig?.similarityThreshold ?? s.similarityThreshold;
    const steps = Math.round(deltaPixels / 30);
    const newThreshold = Math.max(0.3, Math.min(0.8, currentThreshold - steps * 0.05));
    const rounded = Math.round(newThreshold * 100) / 100;
    if (rounded === currentConfig?.similarityThreshold) return;
    updatePinnedNodeConfig(node.id, { similarityThreshold: rounded });
    const updated = chatStore.get(graphSettingsAtom);
    plugin.settings.graphSettings = updated;
    plugin.saveSettings();
    debouncedRebuild();
  }, [plugin, debouncedRebuild]);

  if (!activeFile) {
    return (
      <div className="claude-agent-graph-container">
        <div className="claude-agent-graph-empty">
          Open a note to see its semantic graph
        </div>
      </div>
    );
  }

  return (
    <div className="claude-agent-graph-container">
      <div className="claude-agent-graph-canvas-wrapper">
        {error && <div className="claude-agent-graph-error">{error}</div>}

        {graphData && (
          <GraphCanvas
            data={graphData}
            settings={settings}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onNodeContextMenu={handleNodeContextMenu}
            onNodePinToggle={handleNodePinToggle}
            onNodeDepthAdjust={handleNodeDepthAdjust}
            onNodeSimilarityAdjust={handleNodeSimilarityAdjust}
          />
        )}

        <GraphControls
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onRefresh={buildAndSetGraph}
          isLoading={isLoading}
        />

        {!indexAvailable && (
          <div className="claude-agent-graph-notice">
            Copilot index unavailable — showing link-only graph
          </div>
        )}
      </div>

      <GraphTooltip
        node={hoveredNode}
        edges={graphData?.edges ?? []}
        x={tooltipPos.x}
        y={tooltipPos.y}
      />
    </div>
  );
}

export class GraphView extends ItemView {
  private root: Root | null = null;
  private plugin: ClaudeAgentPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Semantic Graph";
  }

  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("claude-agent-graph-view");

    this.root = createRoot(container);
    this.root.render(
      <GraphContainer plugin={this.plugin} app={this.plugin.app} />
    );
  }

  async onClose(): Promise<void> {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
