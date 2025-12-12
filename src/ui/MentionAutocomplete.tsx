import React, { useEffect, useRef, useCallback } from "react";
import { setIcon } from "obsidian";
import { FileSearchResult, getParentPath } from "@/utils/fileSearch";

interface MentionAutocompleteProps {
  results: FileSearchResult[];
  selectedIndex: number;
  onSelect: (file: FileSearchResult) => void;
  position: { top: number; left: number };
}

export function MentionAutocomplete({
  results,
  selectedIndex,
  onSelect,
  position,
}: MentionAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement;
      selected?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (results.length === 0) return null;

  return (
    <div
      className="claude-agent-mention-autocomplete"
      style={{ bottom: position.top, left: position.left }}
      ref={listRef}
    >
      {results.map((file, index) => (
        <MentionItem
          key={file.path}
          file={file}
          isSelected={index === selectedIndex}
          onClick={() => onSelect(file)}
        />
      ))}
    </div>
  );
}

interface MentionItemProps {
  file: FileSearchResult;
  isSelected: boolean;
  onClick: () => void;
}

function MentionItem({ file, isSelected, onClick }: MentionItemProps) {
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, getFileIcon(file.extension));
    }
  }, [file.extension]);

  const parentPath = getParentPath(file.path);

  return (
    <div
      className={`claude-agent-mention-item ${isSelected ? "selected" : ""}`}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()} // Prevent blur on click
    >
      <span ref={iconRef} className="claude-agent-mention-icon" />
      <div className="claude-agent-mention-text">
        <span className="claude-agent-mention-name">{file.name}</span>
        {parentPath && (
          <span className="claude-agent-mention-path">{parentPath}</span>
        )}
      </div>
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
