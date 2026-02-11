/**
 * Canvas-based graph renderer using d3-force simulation and d3-zoom.
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { select } from "d3-selection";
import type { GraphNode, GraphEdge, GraphData, GraphViewSettings } from "@/types";

// Visual encoding — matching Obsidian's built-in local graph
const CENTER_RADIUS = 12;
const NODE_RADIUS = 7;      // uniform size for all non-center nodes
const FONT_SIZE = 12;

interface ThemeColors {
  nodeFocused: string;  // center/active node (warm accent)
  node: string;         // regular nodes (muted blue-gray)
  line: string;         // link edges
  text: string;         // label text
  background: string;
}

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.body);
  return {
    nodeFocused: style.getPropertyValue("--graph-node-focused").trim()
      || style.getPropertyValue("--interactive-accent").trim() || "#d2a8ff",
    node: style.getPropertyValue("--graph-node").trim()
      || style.getPropertyValue("--text-muted").trim() || "#999",
    line: style.getPropertyValue("--graph-line").trim()
      || style.getPropertyValue("--background-modifier-border").trim() || "#444",
    text: style.getPropertyValue("--graph-text").trim()
      || style.getPropertyValue("--text-muted").trim() || "#999",
    background: style.getPropertyValue("--background-primary").trim() || "#1e1e1e",
  };
}

type ForceNode = GraphNode & SimulationNodeDatum;
type ForceLink = GraphEdge & SimulationLinkDatum<ForceNode>;

export interface GraphRendererOptions {
  canvas: HTMLCanvasElement;
  onNodeClick?: (node: GraphNode, newTab?: boolean) => void;
  onNodeHover?: (node: GraphNode | null, x: number, y: number) => void;
  onNodeContextMenu?: (node: GraphNode, event: MouseEvent) => void;
}

// Animation state for smooth transitions
interface AnimState {
  current: number;
  target: number;
}

interface ColorState {
  current: { r: number; g: number; b: number };
  target: { r: number; g: number; b: number };
}

export class GraphRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private simulation: Simulation<ForceNode, ForceLink> | null = null;
  private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> | null = null;

  private nodes: ForceNode[] = [];
  private edges: ForceLink[] = [];
  private settings: GraphViewSettings | null = null;
  private colors: ThemeColors;

  private transform = { x: 0, y: 0, k: 1 };
  private hoveredNode: ForceNode | null = null;
  private hoveredNeighbors: Set<ForceNode> = new Set();
  private draggedNode: ForceNode | null = null;
  private wasDragged = false;
  private animationFrame: number | null = null;

  private onNodeClick?: (node: GraphNode, newTab?: boolean) => void;
  private onNodeHover?: (node: GraphNode | null, x: number, y: number) => void;
  private onNodeContextMenu?: (node: GraphNode, event: MouseEvent) => void;

  private themeObserver: MutationObserver | null = null;
  private forceUpdateTimer: ReturnType<typeof setTimeout> | null = null;

  // Animation state tracking
  private nodeAlphas = new Map<ForceNode, AnimState>();
  private edgeAlphas = new Map<ForceLink, AnimState>();
  private edgeColors = new Map<ForceLink, ColorState>();
  private labelFontSizes = new Map<ForceNode, AnimState>();
  private labelYOffsets = new Map<ForceNode, AnimState>(); // Separate animation for vertical shift
  private lastAnimTime = 0;
  private isAnimating = false;

  // Merged edges: similarity edges that also have a link edge (rendered solid, not dashed)
  private mergedEdges = new Set<ForceLink>();

  constructor(options: GraphRendererOptions) {
    this.canvas = options.canvas;
    this.ctx = this.canvas.getContext("2d")!;
    this.onNodeClick = options.onNodeClick;
    this.onNodeHover = options.onNodeHover;
    this.onNodeContextMenu = options.onNodeContextMenu;
    this.colors = readThemeColors();

    this.setupZoom();
    this.setupMouseHandlers();
    this.observeTheme();
    this.lastAnimTime = performance.now();
  }

  /**
   * Parse a CSS color string to RGB values (0-255).
   * Handles hex, rgb(), and CSS variables.
   */
  private parseColor(color: string): { r: number; g: number; b: number } {
    // Handle CSS variables by reading computed style
    if (color.startsWith("var(")) {
      const varName = color.match(/var\((--[^)]+)\)/)?.[1];
      if (varName) {
        color = getComputedStyle(document.body).getPropertyValue(varName).trim();
      }
    }

    // Try to parse as hex
    if (color.startsWith("#")) {
      const hex = color.slice(1);
      const bigint = parseInt(hex, 16);
      return {
        r: (bigint >> 16) & 255,
        g: (bigint >> 8) & 255,
        b: bigint & 255,
      };
    }

    // Try to parse as rgb() or rgba()
    const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgbMatch) {
      return {
        r: parseInt(rgbMatch[1]),
        g: parseInt(rgbMatch[2]),
        b: parseInt(rgbMatch[3]),
      };
    }

    // Fallback: create a temporary element to get computed color
    const temp = document.createElement("div");
    temp.style.color = color;
    document.body.appendChild(temp);
    const computed = getComputedStyle(temp).color;
    document.body.removeChild(temp);

    const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      return {
        r: parseInt(match[1]),
        g: parseInt(match[2]),
        b: parseInt(match[3]),
      };
    }

    // Ultimate fallback
    return { r: 128, g: 128, b: 128 };
  }

  /**
   * Convert HSL to RGB (all values 0-1 range).
   */
  private hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;

    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  /**
   * Get or initialize color animation state.
   */
  private getColorState(
    map: Map<any, ColorState>,
    key: any,
    initialColor: { r: number; g: number; b: number }
  ): ColorState {
    let state = map.get(key);
    if (!state) {
      state = {
        current: { ...initialColor },
        target: { ...initialColor },
      };
      map.set(key, state);
    }
    return state;
  }

  /**
   * Update the graph with new data and settings.
   */
  setData(data: GraphData, settings: GraphViewSettings): void {
    this.settings = settings;

    // Clone nodes so d3 can mutate x/y
    this.nodes = data.nodes.map((n) => ({ ...n }));

    // Pin center node
    const center = this.nodes.find((n) => n.isCenter);
    if (center) {
      center.fx = 0;
      center.fy = 0;
    }

    // Build edge references
    const nodeById = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = data.edges
      .filter((e) => {
        const sourceId = typeof e.source === "string" ? e.source : e.source.id;
        const targetId = typeof e.target === "string" ? e.target : e.target.id;
        return nodeById.has(sourceId) && nodeById.has(targetId);
      })
      .filter((e) => {
        if (e.type === "link" && !settings.showLinkEdges) return false;
        if (e.type === "similarity" && !settings.showSimilarityEdges) return false;
        return true;
      })
      .map((e) => ({
        ...e,
        source: nodeById.get(typeof e.source === "string" ? e.source : e.source.id)!,
        target: nodeById.get(typeof e.target === "string" ? e.target : e.target.id)!,
      }));

    // Merge overlapping link + similarity edges into a single solid line
    // with the similarity edge's color. Remove the link edge, keep similarity.
    this.mergedEdges.clear();
    if (settings.showLinkEdges && settings.showSimilarityEdges) {
      // Index similarity edges by canonical node pair
      const simByPair = new Map<string, ForceLink>();
      for (const edge of this.edges) {
        if (edge.type === "similarity") {
          const src = (edge.source as ForceNode).id;
          const tgt = (edge.target as ForceNode).id;
          const pairKey = src < tgt ? `${src}\0${tgt}` : `${tgt}\0${src}`;
          simByPair.set(pairKey, edge);
        }
      }

      // Find link edges that overlap with a similarity edge
      const linkEdgesToRemove = new Set<ForceLink>();
      for (const edge of this.edges) {
        if (edge.type === "link") {
          const src = (edge.source as ForceNode).id;
          const tgt = (edge.target as ForceNode).id;
          const pairKey = src < tgt ? `${src}\0${tgt}` : `${tgt}\0${src}`;
          const simEdge = simByPair.get(pairKey);
          if (simEdge) {
            linkEdgesToRemove.add(edge);
            this.mergedEdges.add(simEdge);
          }
        }
      }

      if (linkEdgesToRemove.size > 0) {
        this.edges = this.edges.filter((e) => !linkEdgesToRemove.has(e));
      }
    }

    // Clear animation state for fresh start
    this.nodeAlphas.clear();
    this.edgeAlphas.clear();
    this.edgeColors.clear();
    this.labelFontSizes.clear();
    this.labelYOffsets.clear();
    this.hoveredNode = null;
    this.hoveredNeighbors.clear();

    // Initialize animation state with default values
    this.updateAnimationTargets();

    this.initSimulation();
  }

  /**
   * Resize the canvas to fill its container.
   * Adjusts the zoom transform so the graph stays centered after resize.
   */
  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    // Compute old canvas center from current transform to detect shift
    const oldCx = this.canvas.clientWidth / 2;
    const oldCy = this.canvas.clientHeight / 2;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Shift zoom transform so graph origin tracks the new canvas center
    const newCx = rect.width / 2;
    const newCy = rect.height / 2;
    if (this.zoomBehavior && (oldCx !== 0 || oldCy !== 0)) {
      const dx = newCx - oldCx;
      const dy = newCy - oldCy;
      if (dx !== 0 || dy !== 0) {
        const t = this.transform;
        const adjusted = zoomIdentity.translate(t.x + dx, t.y + dy).scale(t.k);
        select(this.canvas).call(this.zoomBehavior.transform, adjusted);
        // zoomBehavior.transform fires the "zoom" event which updates this.transform
        // so no need to set it manually
      }
    }

    this.draw();
  }

  /**
   * Get or initialize animation state.
   */
  private getAnimState(map: Map<any, AnimState>, key: any, initialValue: number): AnimState {
    let state = map.get(key);
    if (!state) {
      state = { current: initialValue, target: initialValue };
      map.set(key, state);
    }
    return state;
  }

  /**
   * Easing function for smooth transitions (ease-out quart).
   */
  private ease(t: number): number {
    return 1 - Math.pow(1 - t, 4);
  }

  /**
   * Gentler easing for label shift (ease-out quint).
   * Even more cushioned at the end than quart.
   */
  private easeGentle(t: number): number {
    return 1 - Math.pow(1 - t, 5);
  }

  /**
   * Very gentle easing for edge highlights (ease-out quadratic).
   * Soft, gradual transitions that don't draw attention.
   */
  private easeEdge(t: number): number {
    return 1 - Math.pow(1 - t, 2);
  }

  /**
   * Step all animations forward by deltaTime (ms).
   * Returns true if any animation is still in progress.
   */
  private stepAnimations(deltaTime: number): boolean {
    const speed = 0.01; // base transition speed (nodes)
    const fontSizeSpeed = 0.02; // snappier for font size (2x faster)
    const yOffsetSpeed = 0.007; // gentler for position shift (0.7x slower)
    const edgeSpeed = 0.003; // very gentle for edge highlights (~3x slower than nodes)
    const threshold = 0.001; // snap to target when close enough
    let anyActive = false;

    const lerp = (current: number, target: number, animSpeed: number, easeFn = this.ease.bind(this)): number => {
      const delta = target - current;
      if (Math.abs(delta) < threshold) return target;
      anyActive = true;
      return current + delta * easeFn(animSpeed * deltaTime);
    };

    // Animate node alphas
    for (const state of this.nodeAlphas.values()) {
      state.current = lerp(state.current, state.target, speed);
    }

    // Animate edge alphas (gentle, separate from nodes)
    for (const state of this.edgeAlphas.values()) {
      state.current = lerp(state.current, state.target, edgeSpeed, this.easeEdge.bind(this));
    }

    // Animate label font sizes (snappier)
    for (const state of this.labelFontSizes.values()) {
      state.current = lerp(state.current, state.target, fontSizeSpeed);
    }

    // Animate label Y offsets (gentler, with softer easing)
    for (const state of this.labelYOffsets.values()) {
      state.current = lerp(state.current, state.target, yOffsetSpeed, this.easeGentle.bind(this));
    }

    // Animate edge colors (gentle, separate from nodes)
    for (const state of this.edgeColors.values()) {
      state.current.r = lerp(state.current.r, state.target.r, edgeSpeed, this.easeEdge.bind(this));
      state.current.g = lerp(state.current.g, state.target.g, edgeSpeed, this.easeEdge.bind(this));
      state.current.b = lerp(state.current.b, state.target.b, edgeSpeed, this.easeEdge.bind(this));
    }

    return anyActive;
  }

  /**
   * Update animation targets based on current hover state.
   */
  private updateAnimationTargets(): void {
    const hoverActive = this.hoveredNode !== null;

    // Update node targets
    for (const node of this.nodes) {
      const isHovered = node === this.hoveredNode;
      const isNeighbor = this.hoveredNeighbors.has(node);
      const isCenter = node.isCenter;

      // Alpha target
      let targetAlpha = 1;
      if (hoverActive && !isHovered && !isNeighbor && !isCenter) {
        targetAlpha = 0.15;
      } else if (hoverActive && isCenter && !isHovered && !isNeighbor) {
        targetAlpha = 0.4;
      }
      this.getAnimState(this.nodeAlphas, node, targetAlpha).target = targetAlpha;

      // Label font size target (snappier animation)
      const baseFontSize = isCenter ? FONT_SIZE + 2 : FONT_SIZE;
      const targetFontSize = isHovered ? baseFontSize + 3 : baseFontSize;
      const fontState = this.getAnimState(this.labelFontSizes, node, targetFontSize);
      fontState.target = targetFontSize;

      // Label Y-offset target (gentler animation, independent from font size)
      const targetYOffset = isHovered ? 11 : 0; // 7.5px additional downward shift when hovered
      const yOffsetState = this.getAnimState(this.labelYOffsets, node, targetYOffset);
      yOffsetState.target = targetYOffset;

      // Debug logging
      if (isHovered) {
        console.log(`[Font Anim] Node ${node.title}: fontSize=${fontState.current.toFixed(1)}→${fontState.target}, yOffset=${yOffsetState.current.toFixed(1)}→${yOffsetState.target}`);
      }
    }

    // Update edge targets
    for (const edge of this.edges) {
      const src = edge.source as ForceNode;
      const tgt = edge.target as ForceNode;
      const connected = src === this.hoveredNode || tgt === this.hoveredNode;

      // Alpha target (uniform for both edge types)
      let targetAlpha = 1;
      if (hoverActive && connected) {
        targetAlpha = 1;
      } else if (hoverActive) {
        targetAlpha = 0.12;
      } else {
        targetAlpha = 0.5;
      }
      this.getAnimState(this.edgeAlphas, edge, targetAlpha).target = targetAlpha;

      // Color target
      let targetColor: { r: number; g: number; b: number };
      if (edge.type === "similarity") {
        // Always use hue-based gradient — opacity handles highlighting
        const t = edge.weight;
        const hue = Math.min(t - 0.3, 0.5) / 0.5 * 120;
        targetColor = this.hslToRgb(hue, 0.7, 0.55);
      } else {
        // Link edge
        if (hoverActive && connected) {
          // Highlighted link edge → accent color
          targetColor = this.parseColor(this.colors.nodeFocused);
        } else {
          // Normal/dimmed link edge → theme line color
          targetColor = this.parseColor(this.colors.line);
        }
      }

      const colorState = this.getColorState(
        this.edgeColors,
        edge,
        targetColor
      );
      colorState.target = targetColor;
    }
  }

  /**
   * Start the animation loop if not already running.
   */
  private startAnimation(): void {
    if (this.isAnimating) {
      console.log("[Animation] Already animating, skipping start");
      return;
    }
    console.log("[Animation] Starting animation loop");
    this.isAnimating = true;
    this.lastAnimTime = performance.now();
    this.animateLoop();
  }

  /**
   * Animation loop that continues until all transitions complete.
   */
  private animateLoop = (): void => {
    if (!this.isAnimating) return;

    const now = performance.now();
    const deltaTime = now - this.lastAnimTime;
    this.lastAnimTime = now;

    const stillAnimating = this.stepAnimations(deltaTime);
    this.drawFrame();

    if (stillAnimating) {
      requestAnimationFrame(this.animateLoop);
    } else {
      console.log("[Animation] Animation loop complete, stopping");
      this.isAnimating = false;
    }
  };

  /**
   * Clean up all resources.
   */
  destroy(): void {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.forceUpdateTimer) {
      clearTimeout(this.forceUpdateTimer);
      this.forceUpdateTimer = null;
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect();
      this.themeObserver = null;
    }
    // Remove zoom behavior
    select(this.canvas).on(".zoom", null);
    // Remove mouse handlers
    this.canvas.removeEventListener("mousemove", this.handleMouseMove);
    this.canvas.removeEventListener("mousedown", this.handleMouseDown);
    this.canvas.removeEventListener("mouseup", this.handleMouseUp);
    this.canvas.removeEventListener("click", this.handleClick);
    this.canvas.removeEventListener("auxclick", this.handleAuxClick);
    this.canvas.removeEventListener("contextmenu", this.handleContextMenu);
  }

  // ========== Private ==========

  /**
   * Update force parameters in-place without rebuilding the simulation.
   * Use this for physics-only changes (centerForce, repelForce, linkDistance)
   * so nodes keep their positions.
   */
  updateForces(settings: GraphViewSettings): void {
    this.settings = settings;
    if (!this.simulation) return;

    const baseDist = settings.linkDistance;
    const linkForce = this.simulation.force("link") as ReturnType<typeof forceLink> | undefined;
    if (linkForce) {
      (linkForce as any).distance((d: ForceLink) => d.type === "similarity" ? baseDist * 1.4 : baseDist);
    }

    const charge = this.simulation.force("charge") as ReturnType<typeof forceManyBody> | undefined;
    if (charge) {
      (charge as any).strength(-settings.repelForce);
    }

    const center = this.simulation.force("center") as ReturnType<typeof forceCenter> | undefined;
    if (center) {
      (center as any).strength(settings.centerForce);
    }

    // Keep simulation gently warm while slider is being dragged —
    // alphaTarget gives smooth continuous motion instead of sudden jumps
    this.simulation.alphaTarget(0.05).restart();

    // Once slider stops moving, let the simulation cool naturally
    if (this.forceUpdateTimer) clearTimeout(this.forceUpdateTimer);
    this.forceUpdateTimer = setTimeout(() => {
      this.simulation?.alphaTarget(0);
    }, 300);
  }

  private initSimulation(): void {
    if (this.simulation) this.simulation.stop();
    const s = this.settings!;

    const baseDist = s.linkDistance;
    const linkForce = forceLink<ForceNode, ForceLink>(this.edges)
      .id((d) => d.id)
      .distance((d) => d.type === "similarity" ? baseDist * 1.4 : baseDist)
      .strength((d) => d.type === "similarity" ? 0.25 : 1.0);

    this.simulation = forceSimulation<ForceNode>(this.nodes)
      .force("link", linkForce)
      .force("charge", forceManyBody().strength(-s.repelForce).distanceMax(600))
      .force("center", forceCenter(0, 0).strength(s.centerForce))
      .force("collide", forceCollide<ForceNode>().radius((d) => (d.isCenter ? CENTER_RADIUS : NODE_RADIUS) + 4))
      .alphaDecay(0.05)
      .velocityDecay(0.6)
      .on("tick", () => this.draw());

    // Reheat on new data
    this.simulation.alpha(0.6).restart();
  }

  private setupZoom(): void {
    this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 5])
      .filter((event: Event) => {
        // Let scroll/wheel events through for zooming regardless of node
        if (event.type === "wheel") return true;
        // Block zoom panning when mousedown lands on a node
        if (event.type === "mousedown") {
          const me = event as MouseEvent;
          return this.findNodeAt(me.clientX, me.clientY) === null;
        }
        return true;
      })
      .on("start", (event) => {
        // Show grabbing cursor only when panning (mousedown-initiated, not wheel zoom)
        if (event.sourceEvent?.type === "mousedown") {
          this.canvas.style.cursor = "grabbing";
        }
      })
      .on("zoom", (event) => {
        this.transform = event.transform;
        this.draw();
      })
      .on("end", () => {
        this.canvas.style.cursor = this.hoveredNode ? "pointer" : "default";
      });

    select(this.canvas).call(this.zoomBehavior);

    // Initialize transform with canvas center so graph origin (0,0) appears centered.
    // This bakes cx/cy into the d3-zoom transform so zoom-to-cursor works correctly.
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const cx = (rect?.width ?? 0) / 2;
    const cy = (rect?.height ?? 0) / 2;
    const initialTransform = zoomIdentity.translate(cx, cy);
    select(this.canvas).call(this.zoomBehavior.transform, initialTransform);
  }

  private setupMouseHandlers(): void {
    this.canvas.addEventListener("mousemove", this.handleMouseMove);
    this.canvas.addEventListener("mousedown", this.handleMouseDown);
    this.canvas.addEventListener("mouseup", this.handleMouseUp);
    this.canvas.addEventListener("click", this.handleClick);
    this.canvas.addEventListener("auxclick", this.handleAuxClick);
    this.canvas.addEventListener("contextmenu", this.handleContextMenu);
  }

  private observeTheme(): void {
    this.themeObserver = new MutationObserver(() => {
      this.colors = readThemeColors();
      this.draw();
    });
    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  private screenToGraph(sx: number, sy: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const gx = (sx - rect.left - this.transform.x) / this.transform.k;
    const gy = (sy - rect.top - this.transform.y) / this.transform.k;
    return [gx, gy];
  }

  private findNodeAt(sx: number, sy: number): ForceNode | null {
    const [gx, gy] = this.screenToGraph(sx, sy);
    // Search in reverse order so top-drawn nodes are found first
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (n.x == null || n.y == null) continue;
      const r = (n.isCenter ? CENTER_RADIUS : NODE_RADIUS) + 2; // small hit tolerance
      const dx = gx - n.x;
      const dy = gy - n.y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  private handleMouseMove = (e: MouseEvent): void => {
    if (this.draggedNode) {
      this.wasDragged = true;
      const [gx, gy] = this.screenToGraph(e.clientX, e.clientY);
      this.draggedNode.fx = gx;
      this.draggedNode.fy = gy;
      // Keep sim warm at low alpha — don't reset to high value each frame
      this.simulation?.alphaTarget(0.1).restart();
      return;
    }

    const node = this.findNodeAt(e.clientX, e.clientY);
    if (node !== this.hoveredNode) {
      this.hoveredNode = node;
      this.hoveredNeighbors.clear();
      if (node) {
        for (const edge of this.edges) {
          const src = edge.source as ForceNode;
          const tgt = edge.target as ForceNode;
          if (src === node) this.hoveredNeighbors.add(tgt);
          if (tgt === node) this.hoveredNeighbors.add(src);
        }
      }
      this.canvas.style.cursor = node ? "pointer" : "default";
      this.onNodeHover?.(node, e.clientX, e.clientY);
      this.updateAnimationTargets();
      this.startAnimation();
    }
  };

  private handleMouseDown = (e: MouseEvent): void => {
    const node = this.findNodeAt(e.clientX, e.clientY);
    if (node) {
      this.draggedNode = node;
      this.wasDragged = false;
      node.fx = node.x;
      node.fy = node.y;
      this.canvas.style.cursor = "grabbing";
    }
  };

  private handleMouseUp = (_e: MouseEvent): void => {
    if (this.draggedNode) {
      // Unpin so forces (especially forceCenter) can pull it back
      this.draggedNode.fx = null;
      this.draggedNode.fy = null;
      this.draggedNode = null;
      // Let simulation cool down immediately so panning is smooth right after
      this.simulation?.alphaTarget(0);
      this.canvas.style.cursor = this.hoveredNode ? "pointer" : "default";
    }
  };

  private handleClick = (e: MouseEvent): void => {
    if (this.wasDragged) return;
    const node = this.findNodeAt(e.clientX, e.clientY);
    if (!node) return;
    if (e.shiftKey && this.onNodeContextMenu) {
      this.onNodeContextMenu(node, e);
    } else if (this.onNodeClick) {
      this.onNodeClick(node, e.metaKey || e.ctrlKey);
    }
  };

  private handleAuxClick = (e: MouseEvent): void => {
    if (e.button !== 1) return; // middle-click only
    const node = this.findNodeAt(e.clientX, e.clientY);
    if (node && this.onNodeClick) {
      e.preventDefault();
      this.onNodeClick(node, true);
    }
  };

  private handleContextMenu = (_e: MouseEvent): void => {
    // No-op: "add to chat" is now shift-click, not right-click
  };

  private draw = (): void => {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = requestAnimationFrame(() => this.drawFrame());
  };

  private drawFrame(): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    this.ctx.clearRect(0, 0, w, h);
    this.ctx.save();
    this.ctx.translate(this.transform.x, this.transform.y);
    this.ctx.scale(this.transform.k, this.transform.k);

    // Draw edges (behind nodes)
    for (const edge of this.edges) {
      this.drawEdge(edge);
    }

    // Draw nodes
    for (const node of this.nodes) {
      this.drawNode(node);
    }

    // Draw labels (on top)
    this.drawLabels();

    this.ctx.restore();
  }

  private isEdgeConnectedToHover(edge: ForceLink): boolean {
    if (!this.hoveredNode) return false;
    const src = edge.source as ForceNode;
    const tgt = edge.target as ForceNode;
    return src === this.hoveredNode || tgt === this.hoveredNode;
  }

  private drawEdge(edge: ForceLink): void {
    const source = edge.source as ForceNode;
    const target = edge.target as ForceNode;
    if (source.x == null || source.y == null || target.x == null || target.y == null) return;

    const hoverActive = this.hoveredNode !== null;
    const connected = this.isEdgeConnectedToHover(edge);

    // Get animated alpha
    const animState = this.getAnimState(this.edgeAlphas, edge, 1);
    const animatedAlpha = animState.current;

    // Get animated color
    const t = edge.weight;
    const defaultColor = edge.type === "similarity"
      ? this.hslToRgb(Math.min(t - 0.3, 0.5) / 0.5 * 120, 0.7, 0.55)
      : this.parseColor(this.colors.line);
    const colorState = this.getColorState(this.edgeColors, edge, defaultColor);
    const animatedColor = colorState.current;

    this.ctx.beginPath();

    if (edge.type === "similarity") {
      const isMerged = this.mergedEdges.has(edge);

      // Merged edges (link + similarity) render solid; pure similarity renders dashed
      if (isMerged) {
        this.ctx.setLineDash([]);
      } else {
        this.ctx.setLineDash([5, 3]);
      }

      // Use animated color (similarity hue gradient)
      this.ctx.strokeStyle = `rgb(${Math.round(animatedColor.r)}, ${Math.round(animatedColor.g)}, ${Math.round(animatedColor.b)})`;
      this.ctx.globalAlpha = animatedAlpha;

      if (hoverActive && connected) {
        this.ctx.lineWidth = 1.5;
      } else if (isMerged) {
        this.ctx.lineWidth = 1;
      } else {
        this.ctx.lineWidth = 0.5;
      }

      if (isMerged) {
        // Straight line for merged edges (same as link edges)
        this.ctx.moveTo(source.x, source.y);
        this.ctx.lineTo(target.x, target.y);
      } else {
        // Slight arc for pure similarity edges
        const mx = (source.x + target.x) / 2;
        const my = (source.y + target.y) / 2;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const offset = len * 0.08;
        const cpx = mx - (dy / len) * offset;
        const cpy = my + (dx / len) * offset;

        this.ctx.moveTo(source.x, source.y);
        this.ctx.quadraticCurveTo(cpx, cpy, target.x, target.y);
      }
    } else {
      this.ctx.setLineDash([]);

      // Use animated color
      this.ctx.strokeStyle = `rgb(${Math.round(animatedColor.r)}, ${Math.round(animatedColor.g)}, ${Math.round(animatedColor.b)})`;
      this.ctx.globalAlpha = animatedAlpha;

      if (hoverActive && connected) {
        this.ctx.lineWidth = 1.5;
      } else if (hoverActive) {
        this.ctx.lineWidth = 1;
      } else {
        this.ctx.lineWidth = 1;
      }

      this.ctx.moveTo(source.x, source.y);
      this.ctx.lineTo(target.x, target.y);
    }

    this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.globalAlpha = 1;
  }

  private drawNode(node: ForceNode): void {
    if (node.x == null || node.y == null) return;

    const hoverActive = this.hoveredNode !== null;
    const isHovered = node === this.hoveredNode;
    const isNeighbor = this.hoveredNeighbors.has(node);
    const isHighlighted = isHovered || isNeighbor;

    // Get animated alpha
    const animAlpha = this.getAnimState(this.nodeAlphas, node, 1).current;

    // Use constant radius (no animation)
    const radius = node.isCenter ? CENTER_RADIUS : NODE_RADIUS;

    this.ctx.beginPath();
    this.ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);

    if (hoverActive && !isHighlighted && !node.isCenter) {
      // Dim: faded out
      this.ctx.fillStyle = this.colors.node;
      this.ctx.globalAlpha = animAlpha;
    } else if (isHovered || (hoverActive && isNeighbor)) {
      // Highlighted: accent color
      this.ctx.fillStyle = this.colors.nodeFocused;
      this.ctx.globalAlpha = animAlpha;
    } else if (node.isCenter) {
      this.ctx.fillStyle = this.colors.nodeFocused;
      this.ctx.globalAlpha = animAlpha;
    } else {
      this.ctx.fillStyle = this.colors.node;
      this.ctx.globalAlpha = animAlpha;
    }

    this.ctx.fill();
    this.ctx.globalAlpha = 1;
  }

  private drawLabels(): void {
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "top";

    const hoverActive = this.hoveredNode !== null;

    for (const node of this.nodes) {
      if (node.x == null || node.y == null) continue;

      const isHovered = node === this.hoveredNode;
      const isNeighbor = this.hoveredNeighbors.has(node);
      const isHighlighted = isHovered || isNeighbor;

      // Get animated values
      const animAlpha = this.getAnimState(this.nodeAlphas, node, 1).current;
      const baseFontSize = node.isCenter ? FONT_SIZE + 1 : FONT_SIZE;
      const animFontSize = this.getAnimState(this.labelFontSizes, node, baseFontSize).current;
      const animYOffset = this.getAnimState(this.labelYOffsets, node, 0).current;

      // Debug logging for hovered node
      if (isHovered) {
        console.log(`[Draw Label] Node ${node.title}: fontSize=${animFontSize.toFixed(1)}px, yOffset=${animYOffset.toFixed(1)}px`);
      }

      // Use constant radius for positioning
      const radius = node.isCenter ? CENTER_RADIUS : NODE_RADIUS;

      // Position with independent Y-offset animation (gentler than font size)
      const y = node.y + radius + 4 + animYOffset;

      const text = node.title;

      if (isHovered) {
        // Hovered label: bright, larger (no bold)
        const fontSizePx = Math.round(animFontSize);
        const fontString = `${fontSizePx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        console.log(`[Font String] Setting font to: "${fontString}"`);
        this.ctx.font = fontString;
        console.log(`[Font String] Actual ctx.font after setting: "${this.ctx.font}"`);
        this.ctx.fillStyle = this.colors.nodeFocused;
        this.ctx.globalAlpha = animAlpha;
      } else if (hoverActive && isHighlighted) {
        // Neighbor label: normal weight, brighter
        this.ctx.font = `${Math.round(animFontSize)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        this.ctx.fillStyle = this.colors.text;
        this.ctx.globalAlpha = animAlpha;
      } else if (hoverActive) {
        // Dim label
        this.ctx.font = `${Math.round(animFontSize)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        this.ctx.fillStyle = this.colors.text;
        this.ctx.globalAlpha = animAlpha;
      } else {
        // Normal
        this.ctx.font = `${Math.round(animFontSize)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        this.ctx.fillStyle = this.colors.text;
        this.ctx.globalAlpha = animAlpha;
      }

      this.ctx.fillText(text, node.x, y);
      this.ctx.globalAlpha = 1;
    }
  }
}
