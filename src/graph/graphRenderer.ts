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
  onNodeClick?: (node: GraphNode) => void;
  onNodeHover?: (node: GraphNode | null, x: number, y: number) => void;
}

// Animation state for smooth transitions
interface AnimState {
  current: number;
  target: number;
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

  private onNodeClick?: (node: GraphNode) => void;
  private onNodeHover?: (node: GraphNode | null, x: number, y: number) => void;

  private themeObserver: MutationObserver | null = null;

  // Animation state tracking
  private nodeAlphas = new Map<ForceNode, AnimState>();
  private edgeAlphas = new Map<ForceLink, AnimState>();
  private nodeRadii = new Map<ForceNode, AnimState>();
  private lastAnimTime = 0;
  private isAnimating = false;

  constructor(options: GraphRendererOptions) {
    this.canvas = options.canvas;
    this.ctx = this.canvas.getContext("2d")!;
    this.onNodeClick = options.onNodeClick;
    this.onNodeHover = options.onNodeHover;
    this.colors = readThemeColors();

    this.setupZoom();
    this.setupMouseHandlers();
    this.observeTheme();
    this.lastAnimTime = performance.now();
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

    // Clear animation state for fresh start
    this.nodeAlphas.clear();
    this.edgeAlphas.clear();
    this.nodeRadii.clear();
    this.hoveredNode = null;
    this.hoveredNeighbors.clear();

    // Initialize animation state with default values
    this.updateAnimationTargets();

    this.initSimulation();
  }

  /**
   * Resize the canvas to fill its container.
   */
  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
   * Easing function for smooth transitions (ease-out cubic).
   */
  private ease(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Step all animations forward by deltaTime (ms).
   * Returns true if any animation is still in progress.
   */
  private stepAnimations(deltaTime: number): boolean {
    const speed = 0.002; // transition speed factor (lower = slower, longer animation)
    const threshold = 0.001; // snap to target when close enough
    let anyActive = false;

    const lerp = (current: number, target: number): number => {
      const delta = target - current;
      if (Math.abs(delta) < threshold) return target;
      anyActive = true;
      return current + delta * this.ease(speed * deltaTime);
    };

    // Animate node alphas
    for (const state of this.nodeAlphas.values()) {
      state.current = lerp(state.current, state.target);
    }

    // Animate edge alphas
    for (const state of this.edgeAlphas.values()) {
      state.current = lerp(state.current, state.target);
    }

    // Animate node radii
    for (const state of this.nodeRadii.values()) {
      state.current = lerp(state.current, state.target);
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

      // Radius target
      const baseRadius = isCenter ? CENTER_RADIUS : NODE_RADIUS;
      const targetRadius = isHovered ? baseRadius + 2 : baseRadius;
      this.getAnimState(this.nodeRadii, node, targetRadius).target = targetRadius;
    }

    // Update edge targets
    for (const edge of this.edges) {
      const src = edge.source as ForceNode;
      const tgt = edge.target as ForceNode;
      const connected = src === this.hoveredNode || tgt === this.hoveredNode;

      let targetAlpha = 1;
      if (hoverActive && connected) {
        targetAlpha = edge.type === "similarity" ? 0.9 : 1;
      } else if (hoverActive) {
        targetAlpha = edge.type === "similarity" ? 0.15 : 0.12;
      } else {
        targetAlpha = edge.type === "similarity" ? 1 : 0.6;
      }
      this.getAnimState(this.edgeAlphas, edge, targetAlpha).target = targetAlpha;
    }
  }

  /**
   * Start the animation loop if not already running.
   */
  private startAnimation(): void {
    if (this.isAnimating) return;
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
  }

  // ========== Private ==========

  private initSimulation(): void {
    if (this.simulation) this.simulation.stop();

    const linkForce = forceLink<ForceNode, ForceLink>(this.edges)
      .id((d) => d.id)
      .distance((d) => {
        return d.type === "similarity" ? 350 : 250;
      })
      .strength((d) => {
        return d.type === "similarity" ? 0.25 : 1.0;
      });

    this.simulation = forceSimulation<ForceNode>(this.nodes)
      .force("link", linkForce)
      .force("charge", forceManyBody().strength(-100).distanceMax(600))
      .force("center", forceCenter(0, 0).strength(0.52))
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
      .on("zoom", (event) => {
        this.transform = event.transform;
        this.draw();
      });

    select(this.canvas).call(this.zoomBehavior);

    // Reset to identity
    select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity);
  }

  private setupMouseHandlers(): void {
    this.canvas.addEventListener("mousemove", this.handleMouseMove);
    this.canvas.addEventListener("mousedown", this.handleMouseDown);
    this.canvas.addEventListener("mouseup", this.handleMouseUp);
    this.canvas.addEventListener("click", this.handleClick);
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
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const gx = (sx - rect.left - cx - this.transform.x) / this.transform.k;
    const gy = (sy - rect.top - cy - this.transform.y) / this.transform.k;
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
      this.canvas.style.cursor = node ? "pointer" : "grab";
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
      this.canvas.style.cursor = this.hoveredNode ? "pointer" : "grab";
    }
  };

  private handleClick = (e: MouseEvent): void => {
    if (this.wasDragged) return;
    const node = this.findNodeAt(e.clientX, e.clientY);
    if (node && this.onNodeClick) {
      this.onNodeClick(node);
    }
  };

  private draw = (): void => {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = requestAnimationFrame(() => this.drawFrame());
  };

  private drawFrame(): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const cx = w / 2;
    const cy = h / 2;

    this.ctx.clearRect(0, 0, w, h);
    this.ctx.save();
    this.ctx.translate(cx + this.transform.x, cy + this.transform.y);
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

    this.ctx.beginPath();

    if (edge.type === "similarity") {
      this.ctx.setLineDash([5, 3]);
      const t = edge.weight;
      const hue = Math.min(t - 0.3, 0.5) / 0.5 * 120;

      if (hoverActive && connected) {
        // Highlight: bright accent
        this.ctx.strokeStyle = this.colors.nodeFocused;
        this.ctx.globalAlpha = animatedAlpha;
        this.ctx.lineWidth = 1.5 + t;
      } else if (hoverActive) {
        // Dim: nearly invisible
        const alpha = Math.pow(t, 3) * 0.9;
        this.ctx.strokeStyle = `hsla(${hue}, 70%, 55%, ${alpha})`;
        this.ctx.globalAlpha = animatedAlpha;
        this.ctx.lineWidth = 0.5 + t * 1.5;
      } else {
        // Normal
        const alpha = Math.pow(t, 3) * 0.9;
        this.ctx.strokeStyle = `hsla(${hue}, 70%, 55%, ${alpha})`;
        this.ctx.globalAlpha = animatedAlpha;
        this.ctx.lineWidth = 0.5 + t * 1.5;
      }

      // Slight arc
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
    } else {
      this.ctx.setLineDash([]);

      if (hoverActive && connected) {
        // Highlight: bright accent
        this.ctx.strokeStyle = this.colors.nodeFocused;
        this.ctx.globalAlpha = animatedAlpha;
        this.ctx.lineWidth = 1.5;
      } else if (hoverActive) {
        // Dim
        this.ctx.strokeStyle = this.colors.line;
        this.ctx.globalAlpha = animatedAlpha;
        this.ctx.lineWidth = 1;
      } else {
        // Normal
        this.ctx.strokeStyle = this.colors.line;
        this.ctx.globalAlpha = animatedAlpha;
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

    // Get animated values
    const animAlpha = this.getAnimState(this.nodeAlphas, node, 1).current;
    const animRadius = this.getAnimState(this.nodeRadii, node, node.isCenter ? CENTER_RADIUS : NODE_RADIUS).current;

    this.ctx.beginPath();
    this.ctx.arc(node.x, node.y, animRadius, 0, Math.PI * 2);

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

      // Use animated radius for label positioning
      const animRadius = this.getAnimState(this.nodeRadii, node, node.isCenter ? CENTER_RADIUS : NODE_RADIUS).current;
      const animAlpha = this.getAnimState(this.nodeAlphas, node, 1).current;
      const y = node.y + animRadius + 4;
      const text = node.title;

      const fontSize = node.isCenter ? FONT_SIZE + 1 : FONT_SIZE;

      if (isHovered) {
        // Hovered label: bold, bright white
        this.ctx.font = `bold ${fontSize}px var(--font-interface, -apple-system, sans-serif)`;
        this.ctx.fillStyle = this.colors.nodeFocused;
        this.ctx.globalAlpha = animAlpha;
      } else if (hoverActive && isHighlighted) {
        // Neighbor label: normal weight, brighter
        this.ctx.font = `${fontSize}px var(--font-interface, -apple-system, sans-serif)`;
        this.ctx.fillStyle = this.colors.text;
        this.ctx.globalAlpha = animAlpha;
      } else if (hoverActive) {
        // Dim label
        this.ctx.font = `${fontSize}px var(--font-interface, -apple-system, sans-serif)`;
        this.ctx.fillStyle = this.colors.text;
        this.ctx.globalAlpha = animAlpha;
      } else {
        // Normal
        this.ctx.font = `${fontSize}px var(--font-interface, -apple-system, sans-serif)`;
        this.ctx.fillStyle = this.colors.text;
        this.ctx.globalAlpha = animAlpha;
      }

      this.ctx.fillText(text, node.x, y);
      this.ctx.globalAlpha = 1;
    }
  }
}
