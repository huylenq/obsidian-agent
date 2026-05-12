import React, { useState, useEffect, useRef } from "react";
import { setIcon } from "obsidian";
import { ToolBlock } from "@/types";
import { displayToolName, getBlockStatus, getToolIcon, type ToolStatus } from "./toolDisplay";
import { WikilinkPill } from "./wikilink/WikilinkPill";
import { NoteMetadataStrip } from "./wikilink/NoteMetadataStrip";
import {
  computeSemanticEditDiff,
  mergeEditDiffs,
  previewSnippet,
  extractWikilinks,
  wordCount,
  type SemanticEditDiff,
} from "./wikilink/noteContent";

interface ToolCallBlockProps {
  block: ToolBlock;
  /** True when rendered inside an expanded ToolGroup body. Suppresses redundant
   *  per-block decorations (the leading lucide icon disc) since the wikilink pill
   *  + verb word already convey what the row represents. */
  inGroup?: boolean;
}

const PKM_VERBS: Record<string, string> = {
  Read: "Read",
  Write: "Wrote",
  Edit: "Edited",
};

function useLucideIcon(ref: React.RefObject<HTMLSpanElement | null>, icon: string) {
  useEffect(() => {
    if (ref.current) setIcon(ref.current, icon);
  }, [ref, icon]);
}

export function ToolCallBlock({ block, inGroup }: ToolCallBlockProps) {
  // Dispatch into specialized renderers when we have the structured fields,
  // otherwise fall through to the generic IDE-syscall rendering.
  if (block.filePath) {
    if (block.toolName === "Read") return <ReadBlock block={block} inGroup={inGroup} />;
    if (block.toolName === "Write") return <WriteBlock block={block} inGroup={inGroup} />;
    if (block.toolName === "Edit") return <EditBlock block={block} inGroup={inGroup} />;
  }
  return <GenericBlock block={block} />;
}

// =====================================================================
// Generic (unchanged) renderer
// =====================================================================

function GenericBlock({ block }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const status = getBlockStatus(block);
  const iconRef = useRef<HTMLSpanElement>(null);
  const chevronRef = useRef<HTMLSpanElement>(null);

  useLucideIcon(iconRef, getToolIcon(block.toolName));
  useLucideIcon(chevronRef, "chevron-right");

  return (
    <div className={`claude-agent-tool-block ${status}`}>
      <div
        className="claude-agent-tool-block-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`claude-agent-tool-icon ${status}`}>
          <span ref={iconRef} />
        </span>
        <span className="claude-agent-tool-block-name">{displayToolName(block.toolName)}</span>
        <span className="claude-agent-tool-block-desc">{block.description}</span>
        <span
          ref={chevronRef}
          className={`claude-agent-tool-block-chevron ${expanded ? "expanded" : ""}`}
        />
      </div>
      {expanded && <BlockBody block={block} />}
    </div>
  );
}

function BlockBody({ block }: ToolCallBlockProps) {
  return (
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
  );
}

// =====================================================================
// Shared PKM header (icon + verb + wikilink + metadata strip)
// =====================================================================

interface PkmHeaderProps {
  block: ToolBlock;
  expanded: boolean;
  onToggle: () => void;
  status: ToolStatus;
  /** Extra inline content rendered after the wikilink, before the chevron. */
  trailing?: React.ReactNode;
  /** Extra row rendered below the wikilink, beside (or replacing) the meta strip. */
  subline?: React.ReactNode;
  /** When true, suppress the leading lucide icon disc — the wikilink pill + verb
   *  already telegraph the operation type, and the icon becomes visual noise
   *  inside an expanded ToolGroup body where every row is a file op. */
  inGroup?: boolean;
}

function PkmHeader({ block, expanded, onToggle, status, trailing, subline, inGroup }: PkmHeaderProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const chevronRef = useRef<HTMLSpanElement>(null);
  useLucideIcon(iconRef, getToolIcon(block.toolName));
  useLucideIcon(chevronRef, "chevron-right");

  const verb = PKM_VERBS[block.toolName] ?? block.toolName;

  return (
    <div className="claude-agent-tool-block-header claude-agent-tool-block-pkm" onClick={onToggle}>
      {!inGroup && (
        <span className={`claude-agent-tool-icon ${status}`}>
          <span ref={iconRef} />
        </span>
      )}
      <div className="claude-agent-tool-block-pkm-main">
        <div className="claude-agent-tool-block-pkm-row">
          <span className="claude-agent-tool-block-pkm-verb">{verb}</span>
          {block.filePath && <WikilinkPill path={block.filePath} />}
          {block.filePath && <NoteMetadataStrip path={block.filePath} />}
          {trailing}
        </div>
        {subline && <div className="claude-agent-tool-block-pkm-subline">{subline}</div>}
      </div>
      <span
        ref={chevronRef}
        className={`claude-agent-tool-block-chevron ${expanded ? "expanded" : ""}`}
      />
    </div>
  );
}

// =====================================================================
// Read renderer
// =====================================================================

function ReadBlock({ block, inGroup }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const status = getBlockStatus(block);
  return (
    <div className={`claude-agent-tool-block ${status}`}>
      <PkmHeader
        block={block}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        status={status}
        inGroup={inGroup}
      />
      {expanded && <BlockBody block={block} />}
    </div>
  );
}

// =====================================================================
// Edit renderer
// =====================================================================

function renderSemanticDiff(diff: SemanticEditDiff): React.ReactNode {
  const hasAnything =
    !diff.isEmpty &&
    (diff.rename?.titleChanged ||
      diff.rename?.aliasesChanged ||
      diff.links.added.length > 0 ||
      diff.links.removed.length > 0 ||
      diff.tags.added.length > 0 ||
      diff.tags.removed.length > 0);
  if (!hasAnything) return null;
  return (
    <div className="claude-agent-edit-semantic-diff">
      {diff.rename?.titleChanged && (
        <span className="claude-agent-edit-rename">
          renamed → <em>"{diff.rename.titleChanged.to ?? ""}"</em>
        </span>
      )}
      {diff.rename?.aliasesChanged && !diff.rename.titleChanged && (
        <span className="claude-agent-edit-rename">aliases changed</span>
      )}
      {diff.links.added.map((l) => (
        <span key={`+l${l}`} className="claude-agent-edit-delta added">
          +<WikilinkPill path={l} small />
        </span>
      ))}
      {diff.links.removed.map((l) => (
        <span key={`-l${l}`} className="claude-agent-edit-delta removed">
          −<WikilinkPill path={l} small />
        </span>
      ))}
      {diff.tags.added.map((t) => (
        <span key={`+t${t}`} className="claude-agent-edit-delta added tag">+{t}</span>
      ))}
      {diff.tags.removed.map((t) => (
        <span key={`-t${t}`} className="claude-agent-edit-delta removed tag">−{t}</span>
      ))}
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <span className="claude-agent-merged-count" title={`${count} consecutive calls on this file`}>
      ×{count}
    </span>
  );
}

function EditBlock({ block, inGroup }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const status = getBlockStatus(block);
  const diff = computeSemanticEditDiff(block.editOld ?? "", block.editNew ?? "");
  const subline = renderSemanticDiff(diff);

  return (
    <div className={`claude-agent-tool-block ${status}`}>
      <PkmHeader
        block={block}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        status={status}
        subline={subline}
        inGroup={inGroup}
      />
      {expanded && <BlockBody block={block} />}
    </div>
  );
}

// =====================================================================
// Write renderer
// =====================================================================

function WriteBlock({ block, inGroup }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const status = getBlockStatus(block);
  const content = block.writeContent ?? "";
  const wc = wordCount(content);
  const overLong = wc > 800;
  // Prefer the server-extracted full wikilink set; fall back to parsing the
  // (truncated) snippet for backward-compat with old transcripts.
  const cited = block.writeLinks ?? extractWikilinks(content);
  const snippet = previewSnippet(content);

  const trailing = overLong ? <WordCountWarning words={wc} /> : null;

  return (
    <div className={`claude-agent-tool-block ${status}`}>
      <PkmHeader
        block={block}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        status={status}
        trailing={trailing}
        inGroup={inGroup}
      />
      <WriteCard snippet={snippet} cited={cited} />
      {expanded && <BlockBody block={block} />}
    </div>
  );
}

function WriteCard({ snippet, cited }: { snippet: string; cited: readonly string[] }) {
  if (!snippet && cited.length === 0) return null;
  return (
    <div className="claude-agent-write-card" onClick={(e) => e.stopPropagation()}>
      {snippet && <div className="claude-agent-write-card-snippet">{snippet}</div>}
      {cited.length > 0 && (
        <div className="claude-agent-write-card-cites">
          {cited.slice(0, 8).map((c) => (
            <WikilinkPill key={c} path={c} small />
          ))}
          {cited.length > 8 && (
            <span className="claude-agent-write-card-cites-more">+{cited.length - 8}</span>
          )}
        </div>
      )}
    </div>
  );
}

function WordCountWarning({ words }: { words: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLucideIcon(ref, "triangle-alert");
  return (
    <span className="claude-agent-write-tag warn" title="Atomic-note guardrail">
      <span ref={ref} className="claude-agent-write-tag-icon" />
      {words} words — consider splitting
    </span>
  );
}

// =====================================================================
// Merged renderer — N consecutive same-tool calls against the same file
// collapse into a single row with an ×N badge and a unified diff (for Edit).
// =====================================================================

interface MergedFileBlockProps {
  /** All ToolBlocks in the run. blocks[0] supplies the verb, filePath, etc.;
   *  blocks[*].editOld/editNew feed the diff aggregation for Edit runs. */
  blocks: ToolBlock[];
  inGroup?: boolean;
}

export function MergedFileBlock({ blocks, inGroup }: MergedFileBlockProps) {
  if (blocks.length === 0) return null;
  const first = blocks[0];
  if (first.toolName === "Edit") return <MergedEditBlock blocks={blocks} inGroup={inGroup} />;
  if (first.toolName === "Write") return <MergedWriteBlock blocks={blocks} inGroup={inGroup} />;
  // Read / MultiEdit — same skeleton, no aggregation beyond the count.
  return <MergedSimpleBlock blocks={blocks} inGroup={inGroup} />;
}

function MergedSimpleBlock({ blocks, inGroup }: MergedFileBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const first = blocks[0];
  const status = getBlockStatus(first);
  return (
    <div className={`claude-agent-tool-block ${status}`}>
      <PkmHeader
        block={first}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        status={status}
        trailing={<CountBadge count={blocks.length} />}
        inGroup={inGroup}
      />
      {expanded && <MergedBlockBody blocks={blocks} />}
    </div>
  );
}

function MergedEditBlock({ blocks, inGroup }: MergedFileBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const first = blocks[0];
  const status = getBlockStatus(first);
  // Aggregate semantic diffs across all edits — added-then-removed cancels.
  const merged = mergeEditDiffs(
    blocks.map((b) => computeSemanticEditDiff(b.editOld ?? "", b.editNew ?? "")),
  );
  const subline = renderSemanticDiff(merged);
  return (
    <div className={`claude-agent-tool-block ${status}`}>
      <PkmHeader
        block={first}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        status={status}
        trailing={<CountBadge count={blocks.length} />}
        subline={subline}
        inGroup={inGroup}
      />
      {expanded && <MergedBlockBody blocks={blocks} />}
    </div>
  );
}

function MergedWriteBlock({ blocks, inGroup }: MergedFileBlockProps) {
  const [expanded, setExpanded] = useState(false);
  // Last-write-wins: card preview reflects the final state on disk.
  const last = blocks[blocks.length - 1];
  const first = blocks[0];
  const status = getBlockStatus(last);
  const content = last.writeContent ?? "";
  const wc = wordCount(content);
  const overLong = wc > 800;
  const cited = last.writeLinks ?? extractWikilinks(content);
  const snippet = previewSnippet(content);
  const trailing = (
    <>
      <CountBadge count={blocks.length} />
      {overLong && <WordCountWarning words={wc} />}
    </>
  );
  return (
    <div className={`claude-agent-tool-block ${status}`}>
      <PkmHeader
        block={first}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        status={status}
        trailing={trailing}
        inGroup={inGroup}
      />
      <WriteCard snippet={snippet} cited={cited} />
      {expanded && <MergedBlockBody blocks={blocks} />}
    </div>
  );
}

// Expanded body for merged rows: stack each underlying call's raw input/output
// with a numbered separator so the chronology stays inspectable.
function MergedBlockBody({ blocks }: { blocks: ToolBlock[] }) {
  return (
    <div className="claude-agent-tool-block-body merged">
      {blocks.map((b, i) => (
        <div key={b.toolUseId} className="claude-agent-merged-step">
          <div className="claude-agent-merged-step-header">
            {i + 1} / {blocks.length}
          </div>
          {b.input && (
            <>
              <span className="claude-agent-tool-block-label">IN</span>
              <pre className="claude-agent-tool-block-content">{b.input}</pre>
            </>
          )}
          {b.output && (
            <>
              <span className={`claude-agent-tool-block-label ${b.isError ? "error" : ""}`}>
                {b.isError ? "ERR" : "OUT"}
              </span>
              <pre className={`claude-agent-tool-block-content ${b.isError ? "error" : ""}`}>
                {b.output}
              </pre>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
