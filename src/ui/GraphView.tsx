/**
 * Semantic Graph View — an interactive force-directed graph combining
 * wiki-link edges with embedding similarity edges.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
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
} from "@/state/graphViewState";
import type { GraphNode, GraphViewSettings, ActiveFileContext, GraphEdge } from "@/types";
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

  // Build graph when active file or settings change
  const buildAndSetGraph = useCallback(async () => {
    if (!activeFile) return;

    setGraphLoading(true);
    setGraphError(null);

    try {
      const data = await buildGraph(
        activeFile.path,
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
  }, [activeFile, app]);

  // Trigger rebuild when active file changes or index becomes available
  useEffect(() => {
    if (activeFile) buildAndSetGraph();
  }, [activeFile, buildAndSetGraph]);

  // Rebuild when settings change
  useEffect(() => {
    if (activeFile) buildAndSetGraph();
  }, [settings]);

  // Handle node click — open the note
  const handleNodeClick = useCallback((node: GraphNode) => {
    app.workspace.openLinkText(node.id, "");
  }, [app]);

  // Handle node hover
  const handleNodeHover = useCallback((node: GraphNode | null, x: number, y: number) => {
    setHoveredNode(node);
    setTooltipPos({ x, y });
  }, []);

  // Handle settings change from controls — update atom and persist
  const handleSettingsChange = useCallback((partial: Partial<GraphViewSettings>) => {
    updateGraphSettings(partial);
    const updated = chatStore.get(graphSettingsAtom);
    plugin.settings.graphSettings = updated;
    plugin.saveSettings();
  }, [plugin]);

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
