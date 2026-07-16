import React, { useEffect, useRef } from "react";
import { setIcon } from "obsidian";
import { ActiveFileContext } from "@/types";

interface ActiveFileChipProps {
  activeFile: ActiveFileContext;
  onClear: () => void;
}

export function ActiveFileChip({ activeFile, onClear }: ActiveFileChipProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const clearIconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, getFileIcon(activeFile.extension));
    }
  }, [activeFile.extension]);

  useEffect(() => {
    if (clearIconRef.current) {
      setIcon(clearIconRef.current, "x");
    }
  }, []);

  return (
    <div className="hermes-agent-active-file-chip">
      <span ref={iconRef} className="hermes-agent-active-file-icon" />
      <span className="hermes-agent-active-file-name">{activeFile.name}</span>
      <span className="hermes-agent-active-file-label">Current</span>
      <button
        className="hermes-agent-active-file-clear"
        onClick={onClear}
        aria-label="Remove file context"
      >
        <span ref={clearIconRef} />
      </button>
    </div>
  );
}

function getFileIcon(extension: string): string {
  switch (extension) {
    case "md":
      return "file-text";
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return "file-code";
    case "json":
      return "braces";
    case "css":
      return "palette";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
      return "image";
    case "pdf":
      return "file-type";
    case "canvas":
      return "layout-dashboard";
    default:
      return "file";
  }
}
