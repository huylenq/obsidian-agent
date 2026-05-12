import React, { useEffect, useMemo, useState } from "react";
import type { GraphData, GraphNode, GraphViewSettings } from "@/types";
import { DEFAULT_GRAPH_VIEW_SETTINGS } from "@/types";
import { buildGraph } from "@/graph/buildGraph";
import { GraphCanvas } from "./GraphView/GraphCanvas";
import { useApp, useIndexClient } from "./AppContext";

interface TouchedGraphPanelProps {
  /** Vault-relative paths the agent Read/Write/Edit'd in this group, in first-touched order. */
  paths: string[];
  /** Subset of `paths` that came from a Write. Plumbed for future styling. */
  writePaths?: Set<string>;
  /** Path of the currently-running tool block, if any. Promoted to graph center. */
  runningPath?: string | null;
}

// Settings tuned for the panel: depth-1 around the touched set, similarity on,
// stronger node-node repulsion so the cluster spreads instead of clumping.
const PANEL_SETTINGS: GraphViewSettings = {
  ...DEFAULT_GRAPH_VIEW_SETTINGS,
  linkDepth: 1,
  showLinkEdges: true,
  showSimilarityEdges: true,
  centerForce: 0.4,
  repelForce: 180,
  linkDistance: 90,
  pinnedNodes: [],
  floatSliders: false,
};

export function TouchedGraphPanel({ paths, runningPath }: TouchedGraphPanelProps) {
  const app = useApp();
  const indexClient = useIndexClient();
  const [data, setData] = useState<GraphData | null>(null);

  // Center: the running file if one is in the touched set, else the first.
  const centerPath = useMemo(
    () => (runningPath && paths.includes(runningPath) ? runningPath : paths[0]),
    [runningPath, paths],
  );

  // All OTHER touched paths become pinned BFS roots so buildGraph expands a
  // 1-hop neighborhood around each. We strip `pinnedConfig` from the result
  // below so the renderer's user-pin indicator badge doesn't show — we just
  // want the warm-orange `isPinned` color to mark "this is a touched file".
  const settings = useMemo<GraphViewSettings>(() => ({
    ...PANEL_SETTINGS,
    pinnedNodes: paths
      .filter((p) => p !== centerPath)
      .map((p) => ({ path: p, linkDepth: 1 as const })),
  }), [paths, centerPath]);

  useEffect(() => {
    let cancelled = false;
    if (!centerPath) {
      setData(null);
      return;
    }
    buildGraph(centerPath, app, indexClient, settings).then((graph) => {
      if (cancelled) return;
      const touchedSet = new Set(paths);
      const annotated: GraphData = {
        ...graph,
        nodes: graph.nodes.map((n) =>
          touchedSet.has(n.id)
            // Mark touched files as isPinned (warm orange) but clear the
            // user-pin config so we don't render a "pinned" indicator badge —
            // these aren't user pins, they're conversation context.
            ? { ...n, isPinned: true, pinnedConfig: undefined }
            : n,
        ),
        edges: graph.edges,
      };
      setData(annotated);
    }).catch((err) => {
      console.warn("[TouchedGraphPanel] buildGraph failed:", err);
      if (!cancelled) setData(null);
    });
    return () => { cancelled = true; };
  }, [app, indexClient, centerPath, settings, paths]);

  const handleNodeClick = (node: GraphNode, newTab?: boolean) => {
    app.workspace.openLinkText(node.id, "", !!newTab);
  };

  // Side-panel skips the heavy tooltip overlay used in the main view.
  const handleNodeHover = (_n: GraphNode | null, _x: number, _y: number) => {};

  if (!data || data.nodes.length === 0) {
    return (
      <div className="claude-agent-touched-graph-panel empty">
        <span className="claude-agent-touched-graph-empty">No vault links</span>
      </div>
    );
  }

  return (
    <div className="claude-agent-touched-graph-panel">
      <GraphCanvas
        data={data}
        settings={settings}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
      />
    </div>
  );
}
