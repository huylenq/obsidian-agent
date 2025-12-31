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
        <div className="claude-agent-relevant-note-badges">
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
        </div>
      </div>
      <div className="claude-agent-relevant-note-preview">
        {truncate(note.content, 150)}
      </div>
      <button
        className="claude-agent-add-to-chat-button"
        onClick={(e) => {
          e.stopPropagation();
          onAddToChat();
        }}
        title="Add to chat as @mention"
      >
        <span ref={addIconRef} />
        <span>Add to Chat</span>
      </button>
    </div>
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + "...";
}
