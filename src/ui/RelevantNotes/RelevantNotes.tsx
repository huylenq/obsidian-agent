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
  const refreshRef = useRef<HTMLSpanElement>(null);
  const fileIconRef = useRef<HTMLSpanElement>(null);
  const chatIconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (chevronRef.current) {
      setIcon(chevronRef.current, isExpanded ? "chevron-down" : "chevron-right");
    }
  }, [isExpanded]);

  useEffect(() => {
    if (refreshRef.current) {
      setIcon(refreshRef.current, "refresh-cw");
    }
    if (fileIconRef.current) {
      setIcon(fileIconRef.current, "file-text");
    }
    if (chatIconRef.current) {
      setIcon(chatIconRef.current, "message-square");
    }
  }, []);

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
            <span ref={fileIconRef} />
          </button>
          <button
            className={searchMode === "chatContext" ? "active" : ""}
            onClick={() => handleModeChange("chatContext")}
            title="Based on chat context"
          >
            <span ref={chatIconRef} />
          </button>
        </div>

        {/* Refresh button */}
        <button
          className="claude-agent-relevant-notes-refresh"
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
          title="Refresh relevant notes"
          disabled={isSearching}
        >
          <span ref={refreshRef} className={isSearching ? "spinning" : ""} />
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
