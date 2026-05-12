import React, { useState, useEffect, useMemo, useRef } from "react";
import { setIcon } from "obsidian";
import { ToolBlock } from "@/types";
import { ToolCallBlock, MergedFileBlock } from "./ToolCallBlock";
import { LinkArcs } from "./LinkArcs";
import { TouchedGraphPanel } from "./TouchedGraphPanel";
import {
  BlockIcon,
  FILE_TOOLS_DEDUPE as FILE_TOOLS,
  getBlockIcons,
  inspectGroup,
  summarizeBlocks,
  SummaryPart,
} from "./toolDisplay";

type GroupedItem =
  | { kind: "single"; block: ToolBlock; key: string }
  | { kind: "merged"; blocks: ToolBlock[]; tool: string; filePath: string; key: string };

// Collapse runs of consecutive same-tool same-file ToolBlocks (Read/Write/Edit/
// MultiEdit only). Singletons pass through unchanged. Non-file tools and
// file-tool blocks without a filePath also pass through.
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
        tool: run[0].toolName,
        filePath: run[0].filePath!,
        key: run.map((b) => b.toolUseId).join("+"),
      });
    }
    run = [];
    runKey = null;
  };

  for (const b of blocks) {
    const key = b.filePath && FILE_TOOLS.has(b.toolName) ? `${b.toolName}::${b.filePath}` : null;
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

function StackedIcon({ icon, isLatest }: { icon: BlockIcon; isLatest: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) setIcon(ref.current, icon.icon);
  }, [icon.icon]);
  return (
    <span
      className={`claude-agent-tool-icon claude-agent-tool-group-icon ${isLatest ? "latest" : ""}`}
      title={icon.label}
    >
      <span ref={ref} />
    </span>
  );
}

export function ToolGroup({ blocks }: ToolGroupProps) {
  const [override, setOverride] = useState<boolean | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const chevronRef = useRef<HTMLSpanElement>(null);
  const graphToggleRef = useRef<HTMLButtonElement>(null);
  // Map of vault-path -> wrapper element of that path's FIRST block in the stack.
  // LinkArcs reads this in a layout effect to compute Y centers for arc endpoints.
  const rowRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const arcLayoutRef = useRef<HTMLDivElement>(null);

  const { status, runningBlock, errorBlock } = inspectGroup(blocks);

  useEffect(() => {
    if (chevronRef.current) setIcon(chevronRef.current, "chevron-right");
    if (graphToggleRef.current) setIcon(graphToggleRef.current, "git-fork");
  }, []);

  if (blocks.length === 1) {
    return <ToolCallBlock block={blocks[0]} />;
  }

  const icons = getBlockIcons(blocks);
  const autoExpanded = status !== "done";
  const expanded = override ?? autoExpanded;
  const runningKey = runningBlock?.toolUseId ?? null;

  // Group consecutive same-file-same-tool blocks into merged items. Anchors
  // for LinkArcs are indexed by the FIRST grouped-item touching each path —
  // when a run merges into one row, that row is the anchor.
  const groupedItems = useMemo(() => groupConsecutiveFileOps(blocks), [blocks]);

  const { vaultPaths, firstItemKeyByPath, runningPath, pathContents } = useMemo(() => {
    const ordered: string[] = [];
    const firstKey = new Map<string, string>();
    // Newest writeContent wins per path — bridges the metadataCache lag for
    // freshly-Written files so LinkArcs can derive outgoing wikilinks
    // immediately instead of waiting for the user to open the file.
    const contents = new Map<string, string>();
    const recordContent = (b: ToolBlock) => {
      if (b.toolName === "Write" && b.filePath && b.writeContent) {
        contents.set(b.filePath, b.writeContent);
      }
    };
    for (const item of groupedItems) {
      let fp: string | null = null;
      if (item.kind === "single") {
        if (item.block.filePath && FILE_TOOLS.has(item.block.toolName)) fp = item.block.filePath;
        recordContent(item.block);
      } else {
        fp = item.filePath;
        for (const b of item.blocks) recordContent(b);
      }
      if (fp && !firstKey.has(fp)) {
        firstKey.set(fp, item.key);
        ordered.push(fp);
      }
    }
    const runP =
      runningBlock && runningBlock.filePath && FILE_TOOLS.has(runningBlock.toolName)
        ? runningBlock.filePath
        : null;
    return {
      vaultPaths: ordered,
      firstItemKeyByPath: firstKey,
      runningPath: runP,
      pathContents: contents,
    };
  }, [groupedItems, runningBlock]);

  const showArcs = vaultPaths.length >= 2;

  // Header caption: live current tool while running, error excerpt on failure,
  // verb summary when done. Done-state captions flag counts so they bold inline.
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
    const setRowRef = (el: HTMLDivElement | null) => {
      if (!filePath) return;
      if (el) rowRefs.current.set(filePath, el);
      else rowRefs.current.delete(filePath);
    };
    return (
      <div
        key={item.key}
        className="claude-agent-tool-group-row"
        ref={isAnchor ? setRowRef : undefined}
      >
        {item.kind === "single"
          ? <ToolCallBlock block={item.block} inGroup />
          : <MergedFileBlock blocks={item.blocks} inGroup />}
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
      >
        <span className="claude-agent-tool-group-icons">
          {icons.map((ic) => (
            <StackedIcon
              key={ic.key}
              icon={ic}
              isLatest={ic.key === runningKey}
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
              // Auto-expand when revealing the graph so the user sees it immediately.
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
          {showArcs ? (
            <div ref={arcLayoutRef} className="claude-agent-tool-group-arc-layout">
              <LinkArcs
                paths={vaultPaths}
                rowRefs={rowRefs}
                containerRef={arcLayoutRef}
                pathContents={pathContents}
              />
              <div className="claude-agent-tool-group-body">
                {groupedItems.map(renderItem)}
              </div>
            </div>
          ) : (
            <div className="claude-agent-tool-group-body">
              {groupedItems.map((item) =>
                item.kind === "single"
                  ? <ToolCallBlock key={item.key} block={item.block} inGroup />
                  : <MergedFileBlock key={item.key} blocks={item.blocks} inGroup />
              )}
            </div>
          )}
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
