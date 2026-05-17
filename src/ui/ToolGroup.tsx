import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { setIcon } from "obsidian";
import { ToolBlock } from "@/types";
import { ToolCallBlock, MergedFileBlock } from "./ToolCallBlock";
import { LinkArcs } from "./LinkArcs";
import { TouchedGraphPanel } from "./TouchedGraphPanel";
import {
  BlockIcon,
  getBlockIcons,
  inspectGroup,
  isFileTool,
  summarizeBlocks,
  SummaryPart,
} from "./toolDisplay";

type GroupedItem =
  | { kind: "single"; block: ToolBlock; key: string }
  | { kind: "merged"; blocks: ToolBlock[]; filePath: string; key: string };

// Collapse runs of consecutive same-tool same-file ToolBlocks into one item so
// "5 Edits to X" renders as one row, not five. Non-file tools and file-tool
// blocks without a filePath pass through as singletons.
function groupConsecutiveFileOps(blocks: ToolBlock[]): GroupedItem[] {
  const items: GroupedItem[] = [];
  let run: ToolBlock[] = [];
  let runKey: string | null = null;

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      items.push({ kind: "single", block: run[0], key: run[0].toolUseId });
    } else {
      items.push({
        kind: "merged",
        blocks: run.slice(),
        filePath: run[0].filePath!,
        key: run.map((b) => b.toolUseId).join("+"),
      });
    }
    run = [];
    runKey = null;
  };

  for (const b of blocks) {
    const key = b.filePath && isFileTool(b.toolName) ? `${b.toolName}::${b.filePath}` : null;
    if (key && key === runKey) {
      run.push(b);
    } else {
      flush();
      if (key) {
        run = [b];
        runKey = key;
      } else {
        items.push({ kind: "single", block: b, key: b.toolUseId });
      }
    }
  }
  flush();
  return items;
}

interface ToolGroupProps {
  blocks: ToolBlock[];
}

// Lucide path data extracted from setIcon's output, cached per icon name.
// Keyed by name → finite (Lucide set), no eviction needed.
const iconInnerCache = new Map<string, string>();
function getIconInnerSvg(name: string): string {
  const hit = iconInnerCache.get(name);
  if (hit !== undefined) return hit;
  const tmp = document.createElement("span");
  setIcon(tmp, name);
  const svg = tmp.firstElementChild;
  const inner = svg && svg.tagName.toLowerCase() === "svg" ? svg.innerHTML : "";
  iconInnerCache.set(name, inner);
  return inner;
}

// Disc mask: keep (right half) ∪ (own glyph silhouette + halo). When stacked
// on top of a previous icon, the disc's left edge follows the glyph outline
// instead of a circular arc — that's the visible "rim cut".
const maskUrlCache = new Map<string, string>();
function getLeftCutMaskUrl(iconName: string): string | null {
  const cached = maskUrlCache.get(iconName);
  if (cached !== undefined) return cached || null;
  const inner = getIconInnerSvg(iconName);
  if (!inner) {
    maskUrlCache.set(iconName, "");
    return null;
  }
  // stroke-width 10 (in 24-unit source space) dilates the silhouette so the
  // kept region overshoots the glyph by a few px → soft halo against the
  // disc behind.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><rect width="22" height="22" fill="black"/><rect x="11" width="11" height="22" fill="white"/><g transform="translate(3.5 3.5) scale(0.625)" style="fill:white;stroke:white;stroke-width:10;stroke-linecap:round;stroke-linejoin:round">${inner}</g></svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  maskUrlCache.set(iconName, url);
  return url;
}

interface StackedIconProps {
  icon: BlockIcon;
  cutLeft: boolean;
  isLatest: boolean;
  stackIndex: number;
}

function StackedIcon({ icon, cutLeft, isLatest, stackIndex }: StackedIconProps) {
  const glyphRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (glyphRef.current) setIcon(glyphRef.current, icon.icon);
  }, [icon.icon]);
  const maskUrl = cutLeft ? getLeftCutMaskUrl(icon.icon) : null;
  const discStyle = maskUrl
    ? ({ WebkitMaskImage: maskUrl, maskImage: maskUrl } as React.CSSProperties)
    : undefined;
  return (
    <span
      className={`claude-agent-tool-icon claude-agent-tool-group-icon ${isLatest ? "latest" : ""}`}
      title={icon.label}
      style={{ ["--stack-index" as string]: stackIndex }}
    >
      <span className="claude-agent-tool-group-icon-disc" style={discStyle} />
      <span ref={glyphRef} className="claude-agent-tool-group-icon-glyph" />
    </span>
  );
}

export function ToolGroup({ blocks }: ToolGroupProps) {
  const [override, setOverride] = useState<boolean | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const chevronRef = useRef<HTMLSpanElement>(null);
  const graphToggleRef = useRef<HTMLButtonElement>(null);
  // CSS dashed-ident-safe scope id so anchor-name attrs from different groups
  // don't collide. useId() returns `:rN:`-style strings; strip the colons.
  const arcScope = useId().replace(/[^a-zA-Z0-9]/g, "");

  const { status, runningBlock, errorBlock } = inspectGroup(blocks);

  useEffect(() => {
    if (chevronRef.current) setIcon(chevronRef.current, "chevron-right");
    if (graphToggleRef.current) setIcon(graphToggleRef.current, "git-fork");
  }, []);

  const groupedItems = useMemo(() => groupConsecutiveFileOps(blocks), [blocks]);

  // Path metadata only depends on the grouped items — split out from runningPath
  // so a running-block toggle doesn't bust the LinkArcs memos.
  const { vaultPaths, firstItemKeyByPath, pathLinks, pathAnchors } = useMemo(() => {
    const ordered: string[] = [];
    const firstKey = new Map<string, string>();
    // Newest writeLinks wins per path — bridges the metadataCache lag so
    // LinkArcs can derive outgoing wikilinks immediately for freshly-Written
    // files, using the full link set the server extracted from the
    // untruncated content (truncating writeContent would have dropped any
    // wikilink past the cutoff).
    const links = new Map<string, readonly string[]>();
    const recordLinks = (b: ToolBlock) => {
      if (b.toolName === "Write" && b.filePath && b.writeLinks) {
        links.set(b.filePath, b.writeLinks);
      }
    };
    for (const item of groupedItems) {
      const fp = item.kind === "single"
        ? (item.block.filePath && isFileTool(item.block.toolName) ? item.block.filePath : null)
        : item.filePath;
      if (item.kind === "single") recordLinks(item.block);
      else for (const b of item.blocks) recordLinks(b);
      if (fp && !firstKey.has(fp)) {
        firstKey.set(fp, item.key);
        ordered.push(fp);
      }
    }
    const anchors = new Map<string, string>();
    ordered.forEach((p, i) => anchors.set(p, `--ca-arc-${arcScope}-${i}`));
    return { vaultPaths: ordered, firstItemKeyByPath: firstKey, pathLinks: links, pathAnchors: anchors };
  }, [groupedItems, arcScope]);

  if (blocks.length === 1) {
    return <ToolCallBlock block={blocks[0]} />;
  }

  const icons = getBlockIcons(blocks);
  const autoExpanded = status !== "done";
  const expanded = override ?? autoExpanded;
  const runningKey = runningBlock?.toolUseId ?? null;

  const runningPath =
    runningBlock?.filePath && isFileTool(runningBlock.toolName) ? runningBlock.filePath : null;

  const showArcs = vaultPaths.length >= 2;

  // Header caption: live current tool while running, error excerpt on failure,
  // verb summary when done.
  let caption: SummaryPart[];
  if (status === "running" && runningBlock) {
    caption = [{ text: runningBlock.description || runningBlock.toolName }];
  } else if (status === "error") {
    const firstLine = errorBlock?.output?.split("\n")[0]?.trim();
    caption = [{ text: firstLine ? `Failed: ${firstLine}` : "Failed" }];
  } else {
    caption = summarizeBlocks(blocks);
  }

  const renderItem = (item: GroupedItem) => {
    const filePath = item.kind === "single" ? item.block.filePath : item.filePath;
    const isAnchor = filePath != null && firstItemKeyByPath.get(filePath) === item.key;
    const anchorName = isAnchor && filePath ? pathAnchors.get(filePath) : undefined;
    return (
      <div key={item.key} className="claude-agent-tool-group-row">
        {item.kind === "single"
          ? <ToolCallBlock block={item.block} inGroup anchorName={anchorName} />
          : <MergedFileBlock blocks={item.blocks} inGroup anchorName={anchorName} />}
      </div>
    );
  };

  return (
    <div className={`claude-agent-tool-group ${status} ${expanded ? "expanded" : ""}`}>
      <div
        className="claude-agent-tool-group-header"
        onClick={() => setOverride(!expanded)}
        role="button"
        aria-expanded={expanded}
        style={{ ["--icon-spread" as string]: `${(icons.length - 1) * 6}px` }}
      >
        <span className="claude-agent-tool-group-icons">
          {icons.map((ic, i) => (
            <StackedIcon
              key={ic.key}
              icon={ic}
              cutLeft={i > 0}
              isLatest={ic.key === runningKey}
              stackIndex={i}
            />
          ))}
        </span>
        <span className={`claude-agent-tool-group-detail ${status}`}>
          {caption.map((p, i) => p.bold
            ? <strong key={i}>{p.text}</strong>
            : <React.Fragment key={i}>{p.text}</React.Fragment>)}
        </span>
        {showArcs && (
          <button
            ref={graphToggleRef}
            type="button"
            className={`claude-agent-tool-group-graph-toggle ${showGraph ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!showGraph && !expanded) setOverride(true);
              setShowGraph((s) => !s);
            }}
            title={showGraph ? "Hide vault graph" : "Show vault graph (neighbors + similarity)"}
            aria-label="Toggle vault graph"
            aria-pressed={showGraph}
          />
        )}
        <span
          ref={chevronRef}
          className={`claude-agent-tool-block-chevron ${expanded ? "expanded" : ""}`}
        />
      </div>
      {expanded && (
        <>
          {/* Arc-layout is the CSS containing block for absolutely-positioned
              arc SVGs. The SVGs are siblings of the body so they share its
              coordinate space; pills inside the body publish anchor-names that
              the SVGs reference via anchor() inset functions. */}
          <div className={`claude-agent-tool-group-arc-layout ${showArcs ? "with-arcs" : ""}`}>
            <div className="claude-agent-tool-group-body">
              {groupedItems.map(renderItem)}
            </div>
            {showArcs && (
              <LinkArcs paths={vaultPaths} pathAnchors={pathAnchors} pathLinks={pathLinks} />
            )}
          </div>
          {showGraph && showArcs && (
            <div className="claude-agent-tool-group-graph">
              <TouchedGraphPanel paths={vaultPaths} runningPath={runningPath} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
