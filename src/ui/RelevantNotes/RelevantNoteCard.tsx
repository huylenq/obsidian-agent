import React, { useEffect, useRef } from "react";
import { setIcon } from "obsidian";
import type { RankedNote } from "@/types";

interface RelevantNoteCardProps {
  note: RankedNote;
  onAddToChat: () => void;
  onOpen: () => void;
}

export function RelevantNoteCard({
  note,
  onAddToChat,
  onOpen,
}: RelevantNoteCardProps) {
  const addIconRef = useRef<HTMLSpanElement>(null);
  const linkIconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (addIconRef.current) {
      setIcon(addIconRef.current, "plus");
    }
  }, []);

  useEffect(() => {
    if (linkIconRef.current && (note.hasOutgoingLink || note.hasBacklink)) {
      setIcon(linkIconRef.current, "link");
    }
  }, [note.hasOutgoingLink, note.hasBacklink]);

  const similarityPercent = Math.round(note.finalScore * 100);

  const cleanedPreview = stripMetadata(note.content);

  return (
    <div className={`claude-agent-relevant-note-card ${note.category}`}>
      <div className="claude-agent-relevant-note-header">
        <span
          className="claude-agent-relevant-note-title"
          onClick={onOpen}
          title={note.path}
        >
          {note.title}
        </span>
        <div className="claude-agent-relevant-note-actions">
          {(note.hasOutgoingLink || note.hasBacklink) && (
            <span
              ref={linkIconRef}
              className="claude-agent-relevant-note-link-badge"
              title={
                note.hasOutgoingLink && note.hasBacklink
                  ? "Linked both ways"
                  : note.hasOutgoingLink
                    ? "Links to this note"
                    : "Backlink from this note"
              }
            />
          )}
          <span className={`claude-agent-similarity-badge ${note.category}`}>
            {similarityPercent}%
          </span>
          <button
            className="claude-agent-add-to-chat-icon"
            onClick={(e) => {
              e.stopPropagation();
              onAddToChat();
            }}
            title="Add to chat"
          >
            <span ref={addIconRef} />
          </button>
        </div>
      </div>
      {cleanedPreview && (
        <div className="claude-agent-relevant-note-preview">
          {truncate(cleanedPreview, 100)}
        </div>
      )}
    </div>
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + "...";
}

/**
 * Strip frontmatter, metadata, and other noise from note content
 * to show a clean preview of actual content.
 */
function stripMetadata(content: string): string {
  let cleaned = content;

  // Remove YAML frontmatter (--- ... ---)
  cleaned = cleaned.replace(/^---[\s\S]*?---\s*/m, "");

  // Remove NOTE TITLE: [[...]] pattern (legacy index artifact)
  cleaned = cleaned.replace(/NOTE TITLE:\s*\[\[[^\]]*\]\]\s*/gi, "");

  // Remove NOTE BLOCK CONTENT: prefix
  cleaned = cleaned.replace(/NOTE BLOCK CONTENT:\s*/gi, "");

  // Remove METADATA:{...} JSON blocks
  cleaned = cleaned.replace(/METADATA:\s*\{[^}]*\}\.{0,3}\s*/gi, "");

  // Remove standalone [[wikilinks]] at the start
  cleaned = cleaned.replace(/^\[\[[^\]]*\]\]\s*/m, "");

  // Collapse multiple newlines/whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}
