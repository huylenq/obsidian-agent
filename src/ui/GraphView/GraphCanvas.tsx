/**
 * React wrapper around the canvas-based GraphRenderer.
 * Handles lifecycle, resize, and forwarding callbacks.
 *
 * Uses a callback-ref pattern: the renderer receives stable wrapper functions
 * that always delegate to the latest prop via a ref. This avoids stale
 * closures when React recreates callbacks after state changes.
 */

import React, { useRef, useEffect } from "react";
import { GraphRenderer } from "@/graph/graphRenderer";
import type { GraphData, GraphNode, GraphViewSettings } from "@/types";

/** Keys that only affect physics/UI — changes to these don't require a full data rebuild. */
const PHYSICS_KEYS: (keyof GraphViewSettings)[] = ["centerForce", "repelForce", "linkDistance", "floatSliders"];

function isPhysicsOnlyChange(prev: GraphViewSettings, next: GraphViewSettings): boolean {
  for (const key of Object.keys(next) as (keyof GraphViewSettings)[]) {
    if (prev[key] !== next[key] && !PHYSICS_KEYS.includes(key)) return false;
  }
  return true;
}

interface GraphCanvasProps {
  data: GraphData;
  settings: GraphViewSettings;
  onNodeClick: (node: GraphNode, newTab?: boolean) => void;
  onNodeHover: (node: GraphNode | null, x: number, y: number) => void;
  onNodeContextMenu?: (node: GraphNode, event: MouseEvent) => void;
  onNodePinToggle?: (node: GraphNode) => void;
  onNodeDepthAdjust?: (node: GraphNode, deltaPixels: number) => void;
  onNodeSimilarityAdjust?: (node: GraphNode, deltaPixels: number) => void;
}

export function GraphCanvas({ data, settings, onNodeClick, onNodeHover, onNodeContextMenu, onNodePinToggle, onNodeDepthAdjust, onNodeSimilarityAdjust }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  // Init to null (not the current props) so the first run of the data/settings
  // effect always fires `setData` — covers consumers that mount with real data
  // already in hand instead of starting empty and updating.
  const prevSettingsRef = useRef<GraphViewSettings | null>(null);
  const prevDataRef = useRef<GraphData | null>(null);

  // Single ref object holding the latest callbacks — updated every render
  const cbRef = useRef({ onNodeClick, onNodeHover, onNodeContextMenu, onNodePinToggle, onNodeDepthAdjust, onNodeSimilarityAdjust });
  cbRef.current = { onNodeClick, onNodeHover, onNodeContextMenu, onNodePinToggle, onNodeDepthAdjust, onNodeSimilarityAdjust };

  // Initialize renderer with stable wrappers that delegate through cbRef
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new GraphRenderer({
      canvas,
      onNodeClick: (node, newTab) => cbRef.current.onNodeClick(node, newTab),
      onNodeHover: (node, x, y) => cbRef.current.onNodeHover(node, x, y),
      onNodeContextMenu: (node, e) => cbRef.current.onNodeContextMenu?.(node, e),
      onNodePinToggle: (node) => cbRef.current.onNodePinToggle?.(node),
      onNodeDepthAdjust: (node, d) => cbRef.current.onNodeDepthAdjust?.(node, d),
      onNodeSimilarityAdjust: (node, d) => cbRef.current.onNodeSimilarityAdjust?.(node, d),
    });
    rendererRef.current = renderer;
    renderer.resize();

    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  // Update data/settings when they change
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const dataChanged = data !== prevDataRef.current;
    const settingsChanged = settings !== prevSettingsRef.current;
    // First run has prev === null → treat as a non-physics-only settings change
    // so the full setData branch fires.
    const physicsOnly = prevSettingsRef.current
      ? isPhysicsOnlyChange(prevSettingsRef.current, settings)
      : false;

    if (dataChanged || (settingsChanged && !physicsOnly)) {
      // Full rebuild needed (data changed, or filter/edge settings changed)
      renderer.setData(data, settings);
    } else if (settingsChanged) {
      // Physics-only change — update forces in place, keep node positions
      renderer.updateForces(settings);
    }

    prevSettingsRef.current = settings;
    prevDataRef.current = data;
  }, [data, settings]);

  // Handle container resize
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const observer = new ResizeObserver(() => renderer.resize());
    const parent = canvasRef.current?.parentElement;
    if (parent) observer.observe(parent);

    return () => observer.disconnect();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="hermes-agent-graph-canvas"
    />
  );
}
