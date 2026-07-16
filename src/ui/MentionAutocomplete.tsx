import React, { useEffect, useRef, useCallback } from "react";
import { setIcon } from "obsidian";
import { FileSearchResult, getParentPath } from "@/utils/fileSearch";

interface MentionAutocompleteProps {
  results: FileSearchResult[];
  selectedIndex: number;
  onSelect: (file: FileSearchResult) => void;
}

export function MentionAutocomplete({
  results,
  selectedIndex,
  onSelect,
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
      className="hermes-agent-mention-autocomplete"
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
      setIcon(iconRef.current, getItemIcon(file));
    }
  }, [file.type, file.extension]);

  const parentPath = getParentPath(file.path);

  return (
    <div
      className={`hermes-agent-mention-item ${isSelected ? "selected" : ""}`}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()} // Prevent blur on click
    >
      <span ref={iconRef} className="hermes-agent-mention-icon" />
      <div className="hermes-agent-mention-text">
        <span className="hermes-agent-mention-name">{file.name}</span>
        {parentPath && (
          <span className="hermes-agent-mention-path">{parentPath}</span>
        )}
      </div>
    </div>
  );
}

function getItemIcon(item: FileSearchResult): string {
  if (item.type === "folder") return "folder";

  switch (item.extension) {
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
