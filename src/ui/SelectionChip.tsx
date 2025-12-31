import React, { useEffect, useRef } from "react";
import { setIcon } from "obsidian";
import { SelectionContext } from "@/types";

interface SelectionChipProps {
  selection: SelectionContext;
  onClear: () => void;
}

function truncateText(text: string, maxLength: number = 50): string {
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return singleLine.slice(0, maxLength - 3) + "...";
}

export function SelectionChip({ selection, onClear }: SelectionChipProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const clearIconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, "text-select");
    }
  }, []);

  useEffect(() => {
    if (clearIconRef.current) {
      setIcon(clearIconRef.current, "x");
    }
  }, []);

  const displayText = truncateText(selection.text);
  const lineInfo =
    selection.startLine !== undefined
      ? selection.startLine === selection.endLine
        ? `L${selection.startLine}`
        : `L${selection.startLine}-${selection.endLine}`
      : null;

  return (
    <div className="claude-agent-selection-chip" title={selection.text}>
      <span ref={iconRef} className="claude-agent-selection-icon" />
      <span className="claude-agent-selection-preview">"{displayText}"</span>
      {lineInfo && (
        <span className="claude-agent-selection-lines">{lineInfo}</span>
      )}
      <span className="claude-agent-selection-label">Selected</span>
      <button
        className="claude-agent-selection-clear"
        onClick={onClear}
        aria-label="Clear selection context"
      >
        <span ref={clearIconRef} />
      </button>
    </div>
  );
}
