import React from "react";
import { TFile } from "obsidian";
import { useApp } from "@/ui/AppContext";

interface NoteMetadataStripProps {
  path: string;
}

const MAX_TAGS = 3;

function relativeTime(mtime: number): string {
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - mtime) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo`;
  const diffYr = Math.floor(diffMo / 12);
  return `${diffYr}y`;
}

function normalizeTag(raw: string): string {
  const t = String(raw).trim();
  return t.startsWith("#") ? t : `#${t}`;
}

/**
 * Compact horizontal strip of note metadata: backlink count, tag chips, mtime.
 * Designed to sit directly under a WikilinkPill.
 *
 * Renders nothing if the path doesn't resolve to a TFile or there's no metadata.
 */
export function NoteMetadataStrip({ path }: NoteMetadataStripProps) {
  const app = useApp();
  const file =
    (app.vault.getAbstractFileByPath(path) as TFile | null) ??
    app.metadataCache.getFirstLinkpathDest(path, "");
  if (!(file instanceof TFile)) return null;

  const cache = app.metadataCache.getFileCache(file);

  // Collect tags from inline tags + frontmatter tags. Dedup, normalize.
  const tagSet = new Set<string>();
  if (cache?.tags) {
    for (const t of cache.tags) tagSet.add(normalizeTag(t.tag));
  }
  const fmTags = cache?.frontmatter?.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) tagSet.add(normalizeTag(t));
  } else if (typeof fmTags === "string") {
    for (const t of fmTags.split(/[\s,]+/)) {
      if (t) tagSet.add(normalizeTag(t));
    }
  }
  const tags = Array.from(tagSet);

  // Backlinks. `getBacklinksForFile` is undocumented; fall back to scanning
  // resolvedLinks if the API isn't available.
  let backlinkCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mc = app.metadataCache as any;
  if (typeof mc.getBacklinksForFile === "function") {
    try {
      const bl = mc.getBacklinksForFile(file);
      backlinkCount = typeof bl?.count === "function" ? bl.count() : 0;
    } catch {
      backlinkCount = 0;
    }
  }
  if (backlinkCount === 0) {
    const resolved = app.metadataCache.resolvedLinks ?? {};
    for (const src of Object.keys(resolved)) {
      if (resolved[src]?.[file.path]) backlinkCount++;
    }
  }

  const hasAnything = backlinkCount > 0 || tags.length > 0 || file.stat?.mtime;
  if (!hasAnything) return null;

  const visibleTags = tags.slice(0, MAX_TAGS);
  const extraTags = tags.length - visibleTags.length;

  return (
    <div className="claude-agent-note-meta-strip">
      {backlinkCount > 0 && (
        <span className="claude-agent-note-meta-chip" title="Backlinks">
          {backlinkCount} backlink{backlinkCount === 1 ? "" : "s"}
        </span>
      )}
      {visibleTags.map((t) => (
        <span key={t} className="claude-agent-note-meta-chip tag" title={t}>
          {t}
        </span>
      ))}
      {extraTags > 0 && (
        <span className="claude-agent-note-meta-chip tag muted">+{extraTags}</span>
      )}
      {file.stat?.mtime && (
        <span className="claude-agent-note-meta-chip muted" title={new Date(file.stat.mtime).toLocaleString()}>
          {relativeTime(file.stat.mtime)}
        </span>
      )}
    </div>
  );
}
