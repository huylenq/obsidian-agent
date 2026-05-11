import React, { useState, useEffect, useRef } from "react";
import { setIcon } from "obsidian";
import { ToolBlock } from "@/types";
import { ToolCallBlock } from "./ToolCallBlock";
import {
  BlockIcon,
  getBlockIcons,
  inspectGroup,
  summarizeBlocks,
  SummaryPart,
} from "./toolDisplay";

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
  const chevronRef = useRef<HTMLSpanElement>(null);

  const { status, runningBlock, errorBlock } = inspectGroup(blocks);

  useEffect(() => {
    if (chevronRef.current) setIcon(chevronRef.current, "chevron-right");
  }, []);

  if (blocks.length === 1) {
    return <ToolCallBlock block={blocks[0]} />;
  }

  const icons = getBlockIcons(blocks);
  const autoExpanded = status !== "done";
  const expanded = override ?? autoExpanded;
  const runningKey = runningBlock?.toolUseId ?? null;

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
        <span
          ref={chevronRef}
          className={`claude-agent-tool-block-chevron ${expanded ? "expanded" : ""}`}
        />
      </div>
      {expanded && (
        <div className="claude-agent-tool-group-body">
          {blocks.map((b) => (
            <ToolCallBlock key={b.toolUseId} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}
