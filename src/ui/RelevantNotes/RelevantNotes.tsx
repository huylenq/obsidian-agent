import React, { useEffect, useRef, useState } from "react";
import { setIcon, type App } from "obsidian";
import { useAtomValue } from "jotai";
import { chatStore } from "@/state/chatState";
import {
  relevantNotesAtom,
  searchModeAtom,
  isSearchingNotesAtom,
  indexAvailableAtom,
  relevantNotesErrorAtom,
  setSearchMode,
} from "@/state/relevantNotesState";
import type { SearchMode } from "@/types";
import { RelevantNoteCard } from "./RelevantNoteCard";

interface RelevantNotesProps {
  app: App;
  onAddToChat: (notePath: string) => void;
  onRefresh: () => void;
}

export function RelevantNotes({
  app,
  onAddToChat,
  onRefresh,
}: RelevantNotesProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const notes = useAtomValue(relevantNotesAtom, { store: chatStore });
  const searchMode = useAtomValue(searchModeAtom, { store: chatStore });
  const isSearching = useAtomValue(isSearchingNotesAtom, { store: chatStore });
  const indexAvailable = useAtomValue(indexAvailableAtom, { store: chatStore });
  const error = useAtomValue(relevantNotesErrorAtom, { store: chatStore });

  const chevronRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (chevronRef.current) {
      setIcon(chevronRef.current, isExpanded ? "chevron-down" : "chevron-right");
    }
  }, [isExpanded]);

  const handleModeChange = (mode: SearchMode) => {
    setSearchMode(mode);
    onRefresh();
  };

  const handleOpenNote = (path: string) => {
    app.workspace.openLinkText(path, "");
  };

  if (!indexAvailable) {
    return (
      <div className="claude-agent-relevant-notes">
        <div className="claude-agent-relevant-notes-header">
          <span ref={chevronRef} className="claude-agent-relevant-notes-chevron" />
          <span>Relevant Notes</span>
        </div>
        <div className="claude-agent-relevant-notes-empty">
          Copilot index not found. Install and enable obsidian-copilot to use this feature.
        </div>
      </div>
    );
  }

  return (
    <div className="claude-agent-relevant-notes">
      <div
        className="claude-agent-relevant-notes-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span ref={chevronRef} className="claude-agent-relevant-notes-chevron" />
        <span>Relevant Notes</span>
        {notes.length > 0 && (
          <span className="claude-agent-relevant-notes-count">{notes.length}</span>
        )}

        {/* Mode toggle - stop propagation to prevent collapse */}
        <div
          className="claude-agent-relevant-notes-mode-toggle"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={searchMode === "currentFile" ? "active" : ""}
            onClick={() => handleModeChange("currentFile")}
            title="Based on current file"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </button>
          <button
            className={searchMode === "chatContext" ? "active" : ""}
            onClick={() => handleModeChange("chatContext")}
            title="Based on chat context"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </div>

        {/* Refresh button */}
        <button
          className={`claude-agent-relevant-notes-refresh ${isSearching ? "spinning" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
          title="Refresh relevant notes"
          disabled={isSearching}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {isExpanded && (
        <div className="claude-agent-relevant-notes-content">
          {error && (
            <div className="claude-agent-relevant-notes-error">{error}</div>
          )}

          {isSearching && (
            <div className="claude-agent-relevant-notes-loading">
              Searching...
            </div>
          )}

          {!isSearching && notes.length === 0 && !error && (
            <div className="claude-agent-relevant-notes-empty">
              No relevant notes found
            </div>
          )}

          {notes.map((note) => (
            <RelevantNoteCard
              key={note.path}
              note={note}
              onAddToChat={() => onAddToChat(note.path)}
              onOpen={() => handleOpenNote(note.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
