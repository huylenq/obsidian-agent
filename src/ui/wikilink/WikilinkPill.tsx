import React, { useRef } from "react";
import { TFile } from "obsidian";
import { useApp } from "@/ui/AppContext";

interface WikilinkPillProps {
  path: string;
  /** Smaller pill — used in inline diffs. */
  small?: boolean;
}

function basenameNoExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/**
 * Pill rendering of a vault note path that behaves like a native Obsidian wikilink:
 * - left-click opens the note
 * - hover triggers the page-preview popover (via `hover-link` workspace event)
 * - if the note doesn't exist (yet), renders muted/italic
 */
export function WikilinkPill({ path, small }: WikilinkPillProps) {
  const app = useApp();
  const elRef = useRef<HTMLSpanElement>(null);

  // Resolve the file. metadataCache.getFirstLinkpathDest also handles linkpath
  // shorthand if the path happens to be a basename rather than a full path.
  const file =
    (app.vault.getAbstractFileByPath(path) as TFile | null) ??
    app.metadataCache.getFirstLinkpathDest(path, "");
  const resolved = file instanceof TFile;
  const display = basenameNoExt(path);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    app.workspace.openLinkText(path, "", e.ctrlKey || e.metaKey);
  };

  const handleMouseOver = (e: React.MouseEvent) => {
    if (!elRef.current) return;
    app.workspace.trigger("hover-link", {
      event: e.nativeEvent,
      source: "claude-agent-tool",
      hoverParent: elRef.current,
      targetEl: elRef.current,
      linktext: path,
      sourcePath: "",
    });
  };

  return (
    <span
      ref={elRef}
      className={`claude-agent-wikilink-pill${small ? " small" : ""}${resolved ? "" : " unresolved"}`}
      onClick={handleClick}
      onMouseOver={handleMouseOver}
      role="link"
      title={path}
    >
      <span className="claude-agent-wikilink-pill-name">{display}</span>
    </span>
  );
}
