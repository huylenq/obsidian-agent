/**
 * React wrapper around the canvas-based GraphRenderer.
 * Handles lifecycle, resize, and forwarding callbacks.
 */

import React, { useRef, useEffect, useCallback } from "react";
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
}

export function GraphCanvas({ data, settings, onNodeClick, onNodeHover, onNodeContextMenu }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const prevSettingsRef = useRef<GraphViewSettings>(settings);
  const prevDataRef = useRef<GraphData>(data);

  // Initialize renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new GraphRenderer({
      canvas,
      onNodeClick,
      onNodeHover,
      onNodeContextMenu,
    });
    rendererRef.current = renderer;
    renderer.resize();

    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []); // only on mount — callbacks are stable refs

  // Update data/settings when they change
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const dataChanged = data !== prevDataRef.current;
    const settingsChanged = settings !== prevSettingsRef.current;

    if (dataChanged || (settingsChanged && !isPhysicsOnlyChange(prevSettingsRef.current, settings))) {
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
      className="claude-agent-graph-canvas"
    />
  );
}
