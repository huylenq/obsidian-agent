import React, { memo, useEffect, useMemo, useState } from "react";
import { TFile } from "obsidian";
import { useApp } from "@/ui/AppContext";
import { resolveVaultFile } from "@/utils/notePath";

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
 * Designed to sit directly next to a WikilinkPill.
 *
 * Renders nothing if the path doesn't resolve to a TFile or there's no metadata.
 */
export const NoteMetadataStrip = memo(function NoteMetadataStrip({ path }: NoteMetadataStripProps) {
  const app = useApp();
  // Bumped on metadata cache changes for this file so derived values refresh
  // without re-running on every parent render.
  const [cacheVersion, setCacheVersion] = useState(0);

  useEffect(() => {
    const handler = (file: TFile) => {
      if (file.path === path) setCacheVersion((v) => v + 1);
    };
    const ref = app.metadataCache.on("changed", handler);
    return () => app.metadataCache.offref(ref);
  }, [app, path]);

  const data = useMemo(() => {
    const file = resolveVaultFile(app, path);
    if (!file) return null;

    const cache = app.metadataCache.getFileCache(file);

    const tagSet = new Set<string>();
    for (const t of cache?.tags ?? []) tagSet.add(normalizeTag(t.tag));
    const fmTags = cache?.frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) tagSet.add(normalizeTag(t));
    } else if (typeof fmTags === "string") {
      for (const t of fmTags.split(/[\s,]+/)) {
        if (t) tagSet.add(normalizeTag(t));
      }
    }
    const tags = Array.from(tagSet);

    // `getBacklinksForFile` is undocumented but present on current Obsidian.
    // When it's available, trust its result — including legitimate zero — to
    // avoid an O(vault) `resolvedLinks` scan that hurts large vaults. Only fall
    // back to the scan if the API is missing entirely or throws.
    let backlinkCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mc = app.metadataCache as any;
    let usedFastPath = false;
    if (typeof mc.getBacklinksForFile === "function") {
      try {
        const bl = mc.getBacklinksForFile(file);
        backlinkCount = typeof bl?.count === "function" ? bl.count() : 0;
        usedFastPath = true;
      } catch {
        /* fall through to scan */
      }
    }
    if (!usedFastPath) {
      const resolved = app.metadataCache.resolvedLinks ?? {};
      for (const src of Object.keys(resolved)) {
        if (resolved[src]?.[file.path]) backlinkCount++;
      }
    }

    return { backlinkCount, tags, mtime: file.stat?.mtime };
  }, [app, path, cacheVersion]);

  if (!data) return null;
  const { backlinkCount, tags, mtime } = data;
  if (backlinkCount === 0 && tags.length === 0 && !mtime) return null;

  const visibleTags = tags.slice(0, MAX_TAGS);
  const extraTags = tags.length - visibleTags.length;

  return (
    <div className="hermes-agent-note-meta-strip">
      {backlinkCount > 0 && (
        <span className="hermes-agent-note-meta-chip" title="Backlinks">
          {backlinkCount} backlink{backlinkCount === 1 ? "" : "s"}
        </span>
      )}
      {visibleTags.map((t) => (
        <span key={t} className="hermes-agent-note-meta-chip tag" title={t}>
          {t}
        </span>
      ))}
      {extraTags > 0 && (
        <span className="hermes-agent-note-meta-chip tag muted">+{extraTags}</span>
      )}
      {mtime && (
        <span className="hermes-agent-note-meta-chip muted" title={new Date(mtime).toLocaleString()}>
          {relativeTime(mtime)}
        </span>
      )}
    </div>
  );
});
