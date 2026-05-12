import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TFile } from "obsidian";
import { useApp } from "./AppContext";
import { basenameNoExt, resolveVaultFile } from "@/utils/notePath";

interface LinkArcsProps {
  /** Vault-relative paths in display order. */
  paths: string[];
  /** path -> CSS dashed-ident written on the corresponding wikilink pill's
   *  `data-arc-anchor` attribute (and `anchor-name` style for future
   *  CSS-anchor-positioning support). LinkArcs reads it via querySelector to
   *  measure pill centres. */
  pathAnchors: ReadonlyMap<string, string>;
  /** Optional outgoing wikilink list per path (from Write blocks' writeLinks).
   *  Bridges metadataCache lag for freshly-Written / history-loaded files. */
  pathLinks?: ReadonlyMap<string, readonly string[]>;
}

interface ArcEdge {
  from: string;
  to: string;
  bidi: boolean;
}

interface ArcGeom {
  key: string;
  /** True if source pill's centre x ≤ target pill's centre x. Picks the
   *  diagonal direction of the bow inside the SVG box. */
  leftFirst: boolean;
  bidi: boolean;
  title: string;
  /** Arc box top-left in arc-layout-local coordinates (with EDGE_BLEED). */
  left: number;
  top: number;
  /** Arc box dimensions — span between the two pill centres on each axis. */
  width: number;
  height: number;
  /** Source pill bottom-centre, in arc-layout-local coords. Anchors a dot
   *  marker that visually declares "the link begins here," hiding the
   *  wide-pill → thin-line shape discontinuity. */
  srcX: number;
  srcY: number;
  /** Target pill top-centre. Anchors the arrowhead. */
  tgtX: number;
  tgtY: number;
  /** CSS rotation (deg, CW from straight-down) so the arrowhead aligns with
   *  the path's tangent at the target endpoint. Derived from the Bezier's
   *  last control point projected through the box's actual aspect ratio. */
  tgtRotDeg: number;
}

// Two unit-curve variants. The SVG box is sized so its diagonal corners coincide
// with the source-pill centre and target-pill centre; the path runs corner-to-
// corner with a gentle bow. preserveAspectRatio="none" stretches the unit curve
// to fit any aspect ratio; vector-effect: non-scaling-stroke keeps the line
// weight constant despite the stretch.
const PATH_TL_BR = "M 0 0 C 0.5 0.25, 0.5 0.75, 1 1"; // src upper-left  → tgt lower-right
const PATH_TR_BL = "M 1 0 C 0.5 0.25, 0.5 0.75, 0 1"; // src upper-right → tgt lower-left

/** Minimum box dimension along an axis where the two pills share that axis,
 *  so the SVG keeps a visible curvature instead of collapsing to a line. */
const MIN_BOX_DIM = 2;

/** The wikilink pill has a 1px transparent border in its CSS — so
 *  getBoundingClientRect reports the outer edge but the visible background
 *  fill ends 1px earlier. Pulling the arc's terminus in by 1px on each side
 *  aligns it with the pill's *visible* edge, eliminating the apparent gap
 *  without overlapping the pill bg (which would double-blend the translucent
 *  stroke and create a darker patch). */
const EDGE_BLEED = 1;

/** Height of the target arrowhead in pixels — must match the .target marker's
 *  height in CSS. The path stops short of the apex by this distance along the
 *  tangent so the line's stroke meets the arrow's base edge-to-edge. */
const ARROW_HEIGHT = 6;

/** Half of the stroke width. With `stroke-linecap: round`, the rendered line
 *  extends past each path endpoint by this much along the tangent. We add it
 *  to the inset on both ends so the *visible* (post-cap) line tips land at
 *  the pill edge (source) and at the arrow base (target). */
const HALF_STROKE = 2;

function geomsEqual(a: ArcGeom[], b: ArcGeom[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.key !== y.key ||
      x.leftFirst !== y.leftFirst ||
      x.bidi !== y.bidi ||
      x.left !== y.left ||
      x.top !== y.top ||
      x.width !== y.width ||
      x.height !== y.height ||
      x.srcX !== y.srcX || x.srcY !== y.srcY ||
      x.tgtX !== y.tgtX || x.tgtY !== y.tgtY ||
      x.tgtRotDeg !== y.tgtRotDeg
    ) return false;
  }
  return true;
}

export function LinkArcs({ paths, pathAnchors, pathLinks }: LinkArcsProps) {
  const app = useApp();
  // First-paint correctness comes from server-side `pathLinks`; this listener
  // only catches post-first-render cache shifts (manual edits, Edit-tool
  // reindexes) by busting the edges memo.
  const [cacheVersion, setCacheVersion] = useState(0);
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const touched = new Set(paths);
    const handler = (file: TFile) => {
      if (touched.has(file.path)) setCacheVersion((v) => v + 1);
    };
    const ref = app.metadataCache.on("changed", handler);
    return () => app.metadataCache.offref(ref);
  }, [app, paths]);

  // Directed adjacency unions two sources so neither is load-bearing alone:
  //   - metadataCache: authoritative when populated
  //   - pathLinks: server-extracted wikilink set from full Write content
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
        // Normalise `from` to the path earlier in display order — downstream
        // measure() assumes source pill sits above target pill.
        if ((indexOf.get(from) ?? 0) <= (indexOf.get(to) ?? 0)) {
          out.push({ from, to, bidi: reverse });
        } else {
          out.push({ from: to, to: from, bidi: reverse });
        }
      }
    }
    return out;
  }, [app, paths, pathLinks, cacheVersion]);

  const [geoms, setGeoms] = useState<ArcGeom[]>([]);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || edges.length === 0) {
      setGeoms((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const root = layer.parentElement;
    if (!root) return;

    // Pill elements are stable for the lifetime of this effect — look them
    // up once instead of re-querying inside every measure() tick.
    const pillByPath = new Map<string, HTMLElement>();
    for (const p of paths) {
      const name = pathAnchors.get(p);
      if (!name) continue;
      const pill = root.querySelector<HTMLElement>(`[data-arc-anchor="${name}"]`);
      if (pill) pillByPath.set(p, pill);
    }

    const measure = () => {
      const rootRect = root.getBoundingClientRect();
      type Pin = { cx: number; top: number; bottom: number };
      const pins = new Map<string, Pin>();
      for (const [p, pill] of pillByPath) {
        const r = pill.getBoundingClientRect();
        pins.set(p, {
          cx: r.left + r.width / 2 - rootRect.left,
          top: r.top - rootRect.top,
          bottom: r.bottom - rootRect.top,
        });
      }
      const next: ArcGeom[] = [];
      for (const e of edges) {
        const s = pins.get(e.from);
        const t = pins.get(e.to);
        if (!s || !t) continue;
        const leftFirst = s.cx <= t.cx;
        const apexX = t.cx;
        const apexY = t.top + EDGE_BLEED;

        //   TL→BR end-tangent in viewBox: (0.5, 0.25)
        //   TR→BL end-tangent in viewBox: (-0.5, 0.25)
        // Both endpoints share this direction for our path; computed from the
        // "full" pill-edge extent (pre-inset) as a stable approximation.
        const fullW = Math.max(Math.abs(s.cx - t.cx), MIN_BOX_DIM);
        const fullH = Math.max(apexY - (s.bottom - EDGE_BLEED), MIN_BOX_DIM);
        const tDx = (leftFirst ? 0.5 : -0.5) * fullW;
        const tDy = 0.25 * fullH;
        const tNorm = Math.hypot(tDx, tDy);
        const tUx = tDx / tNorm;
        const tUy = tDy / tNorm;

        // Path endpoints inset by HALF_STROKE on each end so the round caps'
        // *visible* tips land at the pill edge (source) and the arrow base
        // (target). Target gets ARROW_HEIGHT + HALF_STROKE so the cap meets
        // the arrow base, not the apex.
        const lineStartX = s.cx + HALF_STROKE * tUx;
        const lineStartY = (s.bottom - EDGE_BLEED) + HALF_STROKE * tUy;
        const lineEndX = apexX - (ARROW_HEIGHT + HALF_STROKE) * tUx;
        const lineEndY = apexY - (ARROW_HEIGHT + HALF_STROKE) * tUy;
        const left = Math.min(lineStartX, lineEndX);
        const right = Math.max(lineStartX, lineEndX);
        const boxW = Math.max(right - left, MIN_BOX_DIM);
        const boxH = Math.max(lineEndY - lineStartY, MIN_BOX_DIM);

        // CSS rotate(θ) applies matrix [[cos θ, -sin θ], [sin θ, cos θ]] —
        // the down-arrow direction (0, 1) maps to (-sin θ, cos θ). Matching
        // (dx, dy) gives θ = atan2(-dx, dy). Sign of dx matters — without
        // the negation the arrow rotates the wrong way.
        const tgtRotDeg = (Math.atan2(-tDx, tDy) * 180) / Math.PI;
        next.push({
          key: `${e.from}|${e.to}`,
          leftFirst,
          bidi: e.bidi,
          title: e.bidi
            ? `${basenameNoExt(e.from)} ↔ ${basenameNoExt(e.to)}`
            : `${basenameNoExt(e.from)} → ${basenameNoExt(e.to)}`,
          left,
          top: lineStartY,
          width: boxW,
          height: boxH,
          srcX: s.cx,
          srcY: s.bottom,
          tgtX: apexX,
          tgtY: apexY,
          tgtRotDeg,
        });
      }
      setGeoms((prev) => (geomsEqual(prev, next) ? prev : next));
    };

    measure();
    // Observe each pill (catches metadata strips populating async) plus the
    // root container (catches resize/expand of the surrounding chat panel).
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    for (const pill of pillByPath.values()) ro.observe(pill);
    return () => ro.disconnect();
  }, [edges, paths, pathAnchors]);

  return (
    <div ref={layerRef} className={`claude-agent-link-arcs-layer${geoms.length === 0 ? " empty" : ""}`}>
      {geoms.map((g) => (
        <React.Fragment key={g.key}>
          <svg
            className={`claude-agent-link-arc${g.bidi ? " bidi" : ""}`}
            style={{
              left: `${g.left}px`,
              top: `${g.top}px`,
              width: `${g.width}px`,
              height: `${g.height}px`,
            }}
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-hidden
          >
            <path d={g.leftFirst ? PATH_TL_BR : PATH_TR_BL}>
              <title>{g.title}</title>
            </path>
          </svg>
          <span
            className="claude-agent-link-arc-marker target"
            style={{
              left: `${g.tgtX}px`,
              top: `${g.tgtY}px`,
              ["--rot" as string]: `${g.tgtRotDeg}deg`,
            }}
            aria-hidden
          />
        </React.Fragment>
      ))}
    </div>
  );
}
