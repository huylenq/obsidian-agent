/**
 * React wrapper around the canvas-based GraphRenderer.
 * Handles lifecycle, resize, and forwarding callbacks.
 */

import React, { useRef, useEffect, useCallback } from "react";
import { GraphRenderer } from "@/graph/graphRenderer";
import type { GraphData, GraphNode, GraphViewSettings } from "@/types";

interface GraphCanvasProps {
  data: GraphData;
  settings: GraphViewSettings;
  onNodeClick: (node: GraphNode) => void;
  onNodeHover: (node: GraphNode | null, x: number, y: number) => void;
}

export function GraphCanvas({ data, settings, onNodeClick, onNodeHover }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);

  // Initialize renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new GraphRenderer({
      canvas,
      onNodeClick,
      onNodeHover,
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
    rendererRef.current?.setData(data, settings);
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
