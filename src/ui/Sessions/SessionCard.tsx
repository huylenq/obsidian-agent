import React, { useRef, useEffect } from "react";
import { setIcon } from "obsidian";
import type { SessionEntry } from "@/types";

interface SessionCardProps {
  session: SessionEntry;
  isActive: boolean;
  onSwitch: () => void;
  onToggleStatus: () => void;
}

export function SessionCard({ session, isActive, onSwitch, onToggleStatus }: SessionCardProps) {
  const isDone = session.status === "done";
  const dateStr = formatRelativeDate(session.updatedAt);

  const isFlashcard = session.type === "flashcard_study";
  const typeIconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (isFlashcard && typeIconRef.current) {
      setIcon(typeIconRef.current, "book-open");
    }
  }, [isFlashcard]);

  return (
    <div className={`claude-agent-session-card ${isActive ? "active" : ""}`}>
      <div className="claude-agent-session-card-header">
        <button
          className={`claude-agent-session-status-dot ${isDone ? "done" : "in-progress"}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStatus();
          }}
          title={isDone ? "Mark as in progress" : "Mark as done"}
        >
          {isDone ? "\u2713" : "\u25CF"}
        </button>
        <span
          className="claude-agent-session-card-title"
          onClick={onSwitch}
          title={session.title || session.id}
        >
          {isFlashcard && <span ref={typeIconRef} className="claude-agent-session-type-icon" />}
          {session.title || session.id.slice(0, 12)}
        </span>
        <div className="claude-agent-session-card-meta">
          <span className="claude-agent-session-card-date">{dateStr}</span>
          <span className="claude-agent-session-card-model">{session.model}</span>
        </div>
      </div>
      {session.files.length > 0 && (
        <div className="claude-agent-session-card-files">
          {session.files.slice(0, 3).map((f) => (
            <span key={f} className="claude-agent-session-file-chip" title={f}>
              {f.split("/").pop()}
            </span>
          ))}
          {session.files.length > 3 && (
            <span className="claude-agent-session-file-chip">+{session.files.length - 3}</span>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelativeDate(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 30) return `${days}d`;

  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
