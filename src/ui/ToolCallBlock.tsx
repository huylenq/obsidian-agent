import React, { useState } from "react";
import { ToolBlock } from "@/types";

interface ToolCallBlockProps {
  block: ToolBlock;
}

export function ToolCallBlock({ block }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const statusClass = block.isError
    ? "error"
    : block.isRunning
    ? "running"
    : "done";

  return (
    <div className={`claude-agent-tool-block ${statusClass}`}>
      <div
        className="claude-agent-tool-block-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`claude-agent-tool-block-dot ${statusClass}`} />
        <span className="claude-agent-tool-block-name">{block.toolName}</span>
        <span className="claude-agent-tool-block-desc">{block.description}</span>
        <span className={`claude-agent-tool-block-chevron ${expanded ? "expanded" : ""}`}>
          &#9656;
        </span>
      </div>
      {expanded && (
        <div className="claude-agent-tool-block-body">
          {block.input && (
            <>
              <span className="claude-agent-tool-block-label">IN</span>
              <pre className="claude-agent-tool-block-content">{block.input}</pre>
            </>
          )}
          {block.output && (
            <>
              <span className={`claude-agent-tool-block-label ${block.isError ? "error" : ""}`}>
                {block.isError ? "ERR" : "OUT"}
              </span>
              <pre className={`claude-agent-tool-block-content ${block.isError ? "error" : ""}`}>
                {block.output}
              </pre>
            </>
          )}
          {block.isRunning && !block.output && (
            <span className="claude-agent-tool-block-running">Running...</span>
          )}
        </div>
      )}
    </div>
  );
}
