/**
 * Hover tooltip for graph nodes.
 * Shows title, path, depth, and similarity score.
 */

import React from "react";
import type { GraphNode, GraphEdge } from "@/types";

interface GraphTooltipProps {
  node: GraphNode | null;
  edges: GraphEdge[];
  x: number;
  y: number;
}

export function GraphTooltip({ node, edges, x, y }: GraphTooltipProps) {
  // Find similarity edge weight if this node is connected via similarity to center
  const simEdge = node ? edges.find(
    (e) =>
      e.type === "similarity" &&
      ((typeof e.target === "string" ? e.target : e.target.id) === node.id ||
       (typeof e.source === "string" ? e.source : e.source.id) === node.id),
  ) : undefined;

  return (
    <div
      className={`claude-agent-graph-tooltip${node ? " visible" : ""}`}
      style={{
        left: x + 12,
        top: y - 10,
      }}
    >
      {node && (
        <>
          <div className="claude-agent-graph-tooltip-title">{node.title}</div>
          <div className="claude-agent-graph-tooltip-path">{node.id}</div>
          <div className="claude-agent-graph-tooltip-meta">
            <span>Depth: {node.depth}</span>
            {simEdge && <span>Similarity: {simEdge.weight.toFixed(2)}</span>}
            {node.inVectorIndex && <span className="claude-agent-graph-tooltip-indexed">Indexed</span>}
          </div>
        </>
      )}
    </div>
  );
}
