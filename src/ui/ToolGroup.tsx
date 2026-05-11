import React, { useState, useMemo } from "react";
import { ToolBlock } from "@/types";
import { ToolCallBlock } from "./ToolCallBlock";
import { parseMcpToolName, getGroupStatus } from "./toolDisplay";

interface ToolGroupProps {
  blocks: ToolBlock[];
}

const VERBS: Record<string, { verb: string; noun: string; nounPlural: string }> = {
  Read: { verb: "Read", noun: "file", nounPlural: "files" },
  Write: { verb: "Wrote", noun: "file", nounPlural: "files" },
  Edit: { verb: "Edited", noun: "file", nounPlural: "files" },
  MultiEdit: { verb: "Edited", noun: "file", nounPlural: "files" },
  Bash: { verb: "Ran", noun: "command", nounPlural: "commands" },
  Glob: { verb: "Globbed", noun: "pattern", nounPlural: "patterns" },
  Grep: { verb: "Searched", noun: "pattern", nounPlural: "patterns" },
  Task: { verb: "Delegated", noun: "task", nounPlural: "tasks" },
  Agent: { verb: "Delegated", noun: "task", nounPlural: "tasks" },
  WebFetch: { verb: "Fetched", noun: "URL", nounPlural: "URLs" },
  WebSearch: { verb: "Searched the web", noun: "query", nounPlural: "queries" },
  TodoWrite: { verb: "Updated", noun: "todo", nounPlural: "todos" },
};

function summarize(blocks: ToolBlock[]): string {
  const counts = new Map<string, number>();
  for (const b of blocks) {
    counts.set(b.toolName, (counts.get(b.toolName) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [toolName, count] of counts) {
    const mcp = parseMcpToolName(toolName);
    if (mcp) {
      parts.push(`Used ${mcp.server}/${mcp.tool} ×${count}`);
      continue;
    }
    const v = VERBS[toolName];
    parts.push(v
      ? `${v.verb} ${count} ${count === 1 ? v.noun : v.nounPlural}`
      : `${toolName} ×${count}`);
  }
  return parts.join(" · ");
}

export function ToolGroup({ blocks }: ToolGroupProps) {
  // override = null means "follow auto behavior"; true/false = user pinned it
  const [override, setOverride] = useState<boolean | null>(null);

  const status = getGroupStatus(blocks);
  const runningBlock = blocks.find((b) => b.isRunning);
  const summary = useMemo(() => summarize(blocks), [blocks]);

  if (blocks.length === 1) {
    return <ToolCallBlock block={blocks[0]} />;
  }

  const autoExpanded = status !== "done";
  const expanded = override ?? autoExpanded;

  const liveSuffix = runningBlock
    ? ` · ${runningBlock.toolName}${runningBlock.description ? ` ${runningBlock.description}` : ""}`
    : "";
  const headerText = status === "running" ? `Working… ${summary}${liveSuffix}` : summary;

  return (
    <div className={`claude-agent-tool-group ${status} ${expanded ? "expanded" : ""}`}>
      <div
        className="claude-agent-tool-group-header"
        onClick={() => setOverride(!expanded)}
        role="button"
        aria-expanded={expanded}
      >
        <span className={`claude-agent-tool-block-dot ${status}`} />
        <span className="claude-agent-tool-group-summary">{headerText}</span>
        <span className="claude-agent-tool-group-count">{blocks.length}</span>
        <span className={`claude-agent-tool-block-chevron ${expanded ? "expanded" : ""}`}>
          &#9656;
        </span>
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
