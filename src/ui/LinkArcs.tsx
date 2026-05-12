import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TFile } from "obsidian";
import { useApp } from "./AppContext";
import { basenameNoExt, resolveVaultFile } from "@/utils/notePath";

interface LinkArcsProps {
  /** Vault-relative paths in display order. */
  paths: string[];
  /** Live map of path -> the wrapper DOM element of that row in the stack. */
  rowRefs: React.MutableRefObject<Map<string, HTMLElement | null>>;
  /** The flex container hosting both the gutter and the row stack. Used as the
   *  Y origin for arc positions so the SVG can be coordinate-aligned with rows. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Optional outgoing wikilink list per path (from Write blocks' writeLinks).
   *  Used to derive arcs when Obsidian's metadataCache hasn't indexed a file
   *  yet, or when its cache state has drifted since the session was recorded. */
  pathLinks?: ReadonlyMap<string, readonly string[]>;
}

interface ArcEdge {
  from: string;
  to: string;
  bidi: boolean;
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
 * down/up the gutter rail, then back rightward to the target row. Falls back
 * to sharp corners if the span is too small to round cleanly.
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

/** Cheap equality check on the layout shape — avoids spurious downstream re-renders. */
function layoutsEqual(a: Layout, b: Layout): boolean {
  if (a.height !== b.height) return false;
  if (a.centers.size !== b.centers.size) return false;
  for (const [k, v] of a.centers) {
    if (b.centers.get(k) !== v) return false;
  }
  return true;
}

export function LinkArcs({ paths, rowRefs, containerRef, pathLinks }: LinkArcsProps) {
  const app = useApp();
  const [layout, setLayout] = useState<Layout>({ centers: new Map(), height: 0 });
  // Bumped whenever the metadataCache reindexes a touched file so the `edges`
  // memo refreshes — catches manual edits, Edit-tool reindexes, and any other
  // post-first-render cache shifts. (First-paint correctness comes from
  // server-side writeLinks, not from this listener.)
  const [cacheVersion, setCacheVersion] = useState(0);

  useEffect(() => {
    const touched = new Set(paths);
    const handler = (file: TFile) => {
      if (touched.has(file.path)) setCacheVersion((v) => v + 1);
    };
    const ref = app.metadataCache.on("changed", handler);
    return () => app.metadataCache.offref(ref);
  }, [app, paths]);

  // Directed adjacency unions two sources so neither is load-bearing alone:
  //   - metadataCache: authoritative when populated (any file Obsidian has indexed)
  //   - pathLinks: the wikilink set extracted server-side from the full Write
  //     content (covers freshly-Written files the cache hasn't indexed yet AND
  //     history-loaded Writes whose cache state has drifted since the session)
  const edges = useMemo<ArcEdge[]>(() => {
    const touched = new Set(paths);
    const adj = new Map<string, Set<string>>();
    const addLink = (out: Set<string>, sourcePath: string, linkText: string) => {
      const dest = app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
      if (dest && dest.path !== sourcePath && touched.has(dest.path)) {
        out.add(dest.path);
      }
    };
    for (const p of paths) {
      const out = new Set<string>();
      const file = resolveVaultFile(app, p);
      const cache = file ? app.metadataCache.getFileCache(file) : null;
      for (const lr of cache?.links ?? []) addLink(out, p, lr.link);
      for (const lr of cache?.embeds ?? []) addLink(out, p, lr.link);
      for (const linkText of pathLinks?.get(p) ?? []) addLink(out, p, linkText);
      adj.set(p, out);
    }
    const indexOf = new Map(paths.map((p, i) => [p, i]));
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
        // Normalize "from" to the path appearing earlier in display order so
        // arrowheads always point downward — matches reading direction.
        if ((indexOf.get(from) ?? 0) <= (indexOf.get(to) ?? 0)) {
          out.push({ from, to, bidi: reverse });
        } else {
          out.push({ from: to, to: from, bidi: reverse });
        }
      }
    }
    return out;
  }, [app, paths, pathLinks, cacheVersion]);

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
      const next: Layout = { centers, height: container.getBoundingClientRect().height };
      // Short-circuit no-op updates so a settled layout doesn't busy-loop the
      // ResizeObserver into re-renders.
      setLayout((prev) => (layoutsEqual(prev, next) ? prev : next));
    };
    remeasure();
    const ro = new ResizeObserver(remeasure);
    if (containerRef.current) ro.observe(containerRef.current);
    // Row heights shift when metadata strips populate, so watch each row too.
    for (const path of paths) {
      const el = rowRefs.current.get(path);
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, [paths, rowRefs, containerRef]);

  if (edges.length === 0 || layout.centers.size === 0) {
    return <div className="claude-agent-link-arcs empty" />;
  }

  const W = GUTTER_W;
  const H = layout.height;

  return (
    <svg
      className="claude-agent-link-arcs"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMaxYMin meet"
      aria-hidden
    >
      <defs>
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
                ? `${basenameNoExt(e.from)} ↔ ${basenameNoExt(e.to)}`
                : `${basenameNoExt(e.from)} → ${basenameNoExt(e.to)}`}
            </title>
          </path>
        );
      })}
    </svg>
  );
}
