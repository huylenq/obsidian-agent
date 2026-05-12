import React, { useRef } from "react";
import { useApp } from "@/ui/AppContext";
import { basenameNoExt, resolveVaultFile } from "@/utils/notePath";

interface WikilinkPillProps {
  path: string;
  /** Smaller pill — used in inline diffs. */
  small?: boolean;
  /** CSS dashed-ident (e.g. "--arc-pill-x7-0") published as `anchor-name`, so
   *  an absolutely-positioned arc in the same containing block can pin its
   *  endpoints to this pill's centre. */
  anchorName?: string;
}

/**
 * Pill rendering of a vault note path that behaves like a native Obsidian wikilink:
 * - left-click opens the note
 * - hover triggers the page-preview popover (via `hover-link` workspace event)
 * - if the note doesn't exist (yet), renders muted/italic
 */
export function WikilinkPill({ path, small, anchorName }: WikilinkPillProps) {
  const app = useApp();
  const elRef = useRef<HTMLSpanElement>(null);

  const resolved = resolveVaultFile(app, path) != null;
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

  // `anchor-name` is a newer CSS prop; React passes unknown camelCase style
  // keys through unchanged, and we also stamp `data-arc-anchor` so LinkArcs
  // can query the pill by name without scraping the inline style attribute.
  const style: React.CSSProperties | undefined = anchorName
    ? ({ anchorName } as React.CSSProperties)
    : undefined;

  return (
    <span
      ref={elRef}
      style={style}
      data-arc-anchor={anchorName}
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
