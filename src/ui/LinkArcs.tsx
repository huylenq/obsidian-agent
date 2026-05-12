import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TFile } from "obsidian";
import { useApp } from "./AppContext";
import { extractWikilinks } from "./wikilink/noteContent";

interface LinkArcsProps {
  /** Vault-relative paths in display order. */
  paths: string[];
  /** Live map of path -> the wrapper DOM element of that row in the stack. */
  rowRefs: React.MutableRefObject<Map<string, HTMLElement | null>>;
  /** The flex container hosting both the gutter and the row stack. Used as the
   *  Y origin for arc positions so the SVG can be coordinate-aligned with rows. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Optional raw content per path (typically from Write blocks' writeContent).
   *  Used to derive outgoing wikilinks immediately when Obsidian's metadataCache
   *  hasn't yet indexed a freshly-created file. The cache wins when populated. */
  pathContents?: ReadonlyMap<string, string>;
}

interface ArcEdge {
  from: string;          // source path
  to: string;            // target path
  bidi: boolean;         // both directions exist
}

interface Layout {
  centers: Map<string, number>;
  height: number;
}

const GUTTER_W = 28;
const ARC_MIN_DEPTH = 12;
const ARC_MAX_DEPTH = 22;
const CORNER_R = 6;

/**
 * Rounded-orthogonal path through the gutter:
 *
 *   row A  ●─┐
 *           │
 *           │
 *   row B  ●─┘
 *
 * Anchors at xEnd on each row, runs leftward into the gutter at xLeft, then
 * down/up the gutter rail, then back rightward to the target row. Corners use
 * a quadratic curve for the round. Falls back to sharp corners if the span is
 * too small to round cleanly.
 */
function orthogonalPath(xEnd: number, y1: number, y2: number, depth: number): string {
  const xLeft = xEnd - depth;
  const sign = y2 > y1 ? 1 : -1;
  const r = Math.min(CORNER_R, depth - 1, Math.abs(y2 - y1) / 2 - 1);
  if (r <= 0) {
    return `M ${xEnd} ${y1} L ${xLeft} ${y1} L ${xLeft} ${y2} L ${xEnd} ${y2}`;
  }
  return [
    `M ${xEnd} ${y1}`,
    `L ${xLeft + r} ${y1}`,
    `Q ${xLeft} ${y1} ${xLeft} ${y1 + sign * r}`,
    `L ${xLeft} ${y2 - sign * r}`,
    `Q ${xLeft} ${y2} ${xLeft + r} ${y2}`,
    `L ${xEnd} ${y2}`,
  ].join(" ");
}

export function LinkArcs({ paths, rowRefs, containerRef, pathContents }: LinkArcsProps) {
  const app = useApp();
  const [layout, setLayout] = useState<Layout>({ centers: new Map(), height: 0 });
  // Bumped whenever the metadataCache reindexes a touched file — forces the
  // `edges` memo to recompute so arcs update once Obsidian catches up.
  const [cacheVersion, setCacheVersion] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);

  // Re-extract arcs whenever Obsidian reindexes one of our touched files.
  // Critical for fresh Writes: the file is on disk but metadataCache.links is
  // empty until the cache indexes it (which can lag until the file is opened).
  useEffect(() => {
    const touched = new Set(paths);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (file: TFile) => {
      if (touched.has(file.path)) setCacheVersion((v) => v + 1);
    };
    const ref = app.metadataCache.on("changed", handler);
    return () => app.metadataCache.offref(ref);
  }, [app, paths]);

  // Build directed adjacency: for each touched path, the set of OTHER touched
  // paths it links to. Prefer the metadata cache when it has data (most up to
  // date); fall back to parsing wikilinks out of `pathContents` for files that
  // haven't been indexed yet (typically a brand-new Write).
  const edges = useMemo<ArcEdge[]>(() => {
    const touched = new Set(paths);
    const adj = new Map<string, Set<string>>();
    for (const p of paths) {
      const out = new Set<string>();
      const file = app.vault.getAbstractFileByPath(p);
      const cache = file instanceof TFile ? app.metadataCache.getFileCache(file) : null;
      const cacheRefs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];

      if (cacheRefs.length > 0) {
        for (const lr of cacheRefs) {
          const dest = app.metadataCache.getFirstLinkpathDest(lr.link, p);
          if (dest && dest.path !== p && touched.has(dest.path)) {
            out.add(dest.path);
          }
        }
      } else {
        // No cache data yet — bridge with the content we already have in hand.
        const content = pathContents?.get(p);
        if (content) {
          for (const linkText of extractWikilinks(content)) {
            const dest = app.metadataCache.getFirstLinkpathDest(linkText, p);
            if (dest && dest.path !== p && touched.has(dest.path)) {
              out.add(dest.path);
            }
          }
        }
      }
      adj.set(p, out);
    }
    // Dedup unordered pairs; record bidi.
    const out: ArcEdge[] = [];
    const seen = new Set<string>();
    for (const [from, tos] of adj) {
      for (const to of tos) {
        const a = from < to ? from : to;
        const b = from < to ? to : from;
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const reverse = adj.get(to)?.has(from) === true;
        // Always render the arc with "from" being the path that appears first
        // in the display order so arrowheads make sense visually.
        const fromIdx = paths.indexOf(from);
        const toIdx = paths.indexOf(to);
        if (fromIdx <= toIdx) out.push({ from, to, bidi: reverse });
        else out.push({ from: to, to: from, bidi: reverse });
      }
    }
    return out;
  }, [app, paths, pathContents, cacheVersion]);

  // Measure row Y-centers + container height. Re-runs on layout changes
  // (paths swap, body resize) so streaming updates stay accurate.
  useLayoutEffect(() => {
    const remeasure = () => {
      const container = containerRef.current;
      if (!container) return;
      const cTop = container.getBoundingClientRect().top;
      const centers = new Map<string, number>();
      for (const path of paths) {
        const el = rowRefs.current.get(path);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        centers.set(path, r.top + r.height / 2 - cTop);
      }
      setLayout({ centers, height: container.getBoundingClientRect().height });
    };
    remeasure();
    const ro = new ResizeObserver(remeasure);
    if (containerRef.current) ro.observe(containerRef.current);
    // Watch each row too — row heights change as metadata strips populate.
    for (const path of paths) {
      const el = rowRefs.current.get(path);
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, [paths, rowRefs, containerRef]);

  // Nothing to draw: skip the SVG entirely so the gutter doesn't take up space
  // visually when there's nothing to overlay.
  if (edges.length === 0 || layout.centers.size === 0) {
    return <div className="claude-agent-link-arcs empty" />;
  }

  const W = GUTTER_W;
  const H = layout.height;

  return (
    <svg
      ref={svgRef}
      className="claude-agent-link-arcs"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMaxYMin meet"
      aria-hidden
    >
      <defs>
        {/* Arrowhead — points along path direction; refX positions tip at endpoint. */}
        <marker
          id="claude-agent-arc-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {edges.map((e) => {
        const y1 = layout.centers.get(e.from);
        const y2 = layout.centers.get(e.to);
        if (y1 == null || y2 == null) return null;
        // Depth scales with row span so stacked arcs nest visually rather than
        // landing on the exact same vertical rail.
        const span = Math.abs(y2 - y1);
        const depth = Math.max(ARC_MIN_DEPTH, Math.min(ARC_MAX_DEPTH, 12 + span * 0.03));
        const xEnd = W - 1;
        const d = orthogonalPath(xEnd, y1, y2, depth);
        return (
          <path
            key={`${e.from}|${e.to}`}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth={e.bidi ? 1.6 : 1.1}
            opacity={e.bidi ? 0.9 : 0.65}
            markerEnd="url(#claude-agent-arc-arrow)"
            markerStart={e.bidi ? "url(#claude-agent-arc-arrow)" : undefined}
          >
            <title>
              {e.bidi
                ? `${basename(e.from)} ↔ ${basename(e.to)}`
                : `${basename(e.from)} → ${basename(e.to)}`}
            </title>
          </path>
        );
      })}
    </svg>
  );
}

function basename(p: string): string {
  const last = p.split("/").pop() ?? p;
  return last.replace(/\.md$/i, "");
}
