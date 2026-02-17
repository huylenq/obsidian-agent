import React, { useCallback, useEffect, useRef, useState } from "react";
import { App, ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { useAtomValue } from "jotai";
import { chatStore } from "@/state/chatState";
import {
  sessionsAtom,
  isLoadingSessionsAtom,
  sessionsModeAtom,
  sessionStatusFilterAtom,
  sessionsErrorAtom,
  setSessions,
  setLoadingSessions,
  setSessionsError,
  setSessionsMode,
  setSessionStatusFilter,
} from "@/state/sessionState";
import type { ActiveFileContext, SessionStatus, SessionsMode } from "@/types";
import { SessionCard } from "./Sessions/SessionCard";
import type ClaudeAgentPlugin from "@/main";

export const SESSIONS_VIEW_TYPE = "claude-agent-sessions";

interface SessionsContainerProps {
  plugin: ClaudeAgentPlugin;
  app: App;
}

function ModeToggleButton({ icon, isActive, tooltip, onClick }: {
  icon: string;
  isActive: boolean;
  tooltip: string;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (ref.current) setIcon(ref.current, icon); }, [icon]);
  return (
    <button
      ref={ref}
      className={isActive ? "active" : ""}
      onClick={onClick}
      title={tooltip}
    />
  );
}

function ClickableIcon({ icon, tooltip, onClick, isActive, disabled, className }: {
  icon: string;
  tooltip: string;
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) setIcon(ref.current, icon); }, [icon]);
  return (
    <div
      ref={ref}
      className={`clickable-icon${isActive ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      aria-label={tooltip}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}
    />
  );
}

function SessionsContainer({ plugin, app }: SessionsContainerProps) {
  const sessions = useAtomValue(sessionsAtom, { store: chatStore });
  const isLoading = useAtomValue(isLoadingSessionsAtom, { store: chatStore });
  const mode = useAtomValue(sessionsModeAtom, { store: chatStore });
  const statusFilter = useAtomValue(sessionStatusFilterAtom, { store: chatStore });
  const error = useAtomValue(sessionsErrorAtom, { store: chatStore });

  const [activeFile, setActiveFile] = useState<ActiveFileContext | undefined>(undefined);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    plugin.claudeClient?.getSessionId() ?? null
  );

  // Track active file
  const getActiveFileContext = useCallback((): ActiveFileContext | undefined => {
    const file = app.workspace.getActiveFile();
    if (!file) return undefined;
    return { path: file.path, name: file.name, extension: file.extension };
  }, [app]);

  useEffect(() => {
    const update = () => setActiveFile(getActiveFileContext());
    update();
    app.workspace.on("active-leaf-change", update);
    return () => { app.workspace.off("active-leaf-change", update); };
  }, [app, getActiveFileContext]);

  // Track current session ID via custom events from ChatView
  useEffect(() => {
    const handleSessionChange = (e: CustomEvent<{ sessionId: string | null }>) => {
      setCurrentSessionId(e.detail.sessionId);
    };
    window.addEventListener("claude-agent:session-changed", handleSessionChange as EventListener);
    return () => window.removeEventListener("claude-agent:session-changed", handleSessionChange as EventListener);
  }, []);

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    if (!plugin.claudeClient) return;

    setLoadingSessions(true);
    setSessionsError(null);

    try {
      const currentMode = chatStore.get(sessionsModeAtom);
      const currentStatusFilter = chatStore.get(sessionStatusFilterAtom);

      const filters: { status?: SessionStatus | "all"; file?: string } = {
        status: currentStatusFilter,
      };

      if (currentMode === "thisFile" && activeFile) {
        filters.file = activeFile.path;
      }

      const result = await plugin.claudeClient.fetchSessions(filters);
      setSessions(result);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : "Failed to fetch sessions");
    } finally {
      setLoadingSessions(false);
    }
  }, [plugin.claudeClient, activeFile]);

  // Auto-fetch on active file change (thisFile mode)
  useEffect(() => {
    if (mode === "thisFile") {
      fetchSessions();
    }
  }, [activeFile, mode, fetchSessions]);

  // Re-fetch when status filter changes
  useEffect(() => {
    fetchSessions();
  }, [statusFilter, fetchSessions]);

  // Listen for refresh events (from /sessions command, after chat completes, etc.)
  useEffect(() => {
    const handle = () => fetchSessions();
    window.addEventListener("claude-agent:refresh-sessions", handle);
    return () => window.removeEventListener("claude-agent:refresh-sessions", handle);
  }, [fetchSessions]);

  // Auto-trigger migration on first load
  useEffect(() => {
    const migrate = async () => {
      if (plugin.initializationPromise) {
        await plugin.initializationPromise;
      }
      if (plugin.claudeClient) {
        await plugin.claudeClient.migrateSessionRegistry();
        fetchSessions();
      }
    };
    migrate();
  }, [plugin]);

  const handleModeChange = (newMode: SessionsMode) => {
    setSessionsMode(newMode);
  };

  const handleStatusFilterChange = () => {
    setSessionStatusFilter(statusFilter === "in_progress" ? "all" : "in_progress");
  };

  const handleSwitchSession = (sessionId: string) => {
    window.dispatchEvent(
      new CustomEvent("claude-agent:switch-session", { detail: { sessionId } })
    );
    setCurrentSessionId(sessionId);
  };

  const handleToggleStatus = async (sessionId: string, newStatus: SessionStatus) => {
    if (!plugin.claudeClient) return;
    await plugin.claudeClient.updateSession(sessionId, { status: newStatus });
    fetchSessions();
  };

  return (
    <div className="claude-agent-sessions-standalone">
      <div className="claude-agent-sessions-toolbar">
        {/* Mode toggle */}
        <div className="claude-agent-sessions-mode-toggle">
          <ModeToggleButton
            icon="file"
            isActive={mode === "thisFile"}
            tooltip="Sessions for current file"
            onClick={() => handleModeChange("thisFile")}
          />
          <ModeToggleButton
            icon="files"
            isActive={mode === "all"}
            tooltip="All sessions"
            onClick={() => handleModeChange("all")}
          />
        </div>

        {/* Status filter */}
        <ClickableIcon
          icon="filter"
          tooltip={statusFilter === "in_progress" ? "Showing active only — click for all" : "Showing all — click for active only"}
          onClick={handleStatusFilterChange}
          isActive={statusFilter === "in_progress"}
        />

        {/* Refresh */}
        <ClickableIcon
          icon="refresh-cw"
          tooltip="Refresh sessions"
          onClick={fetchSessions}
          disabled={isLoading}
          className={isLoading ? "spinning" : ""}
        />
      </div>

      <div className={`claude-agent-sessions-list ${isLoading ? "loading" : ""}`}>
        {error && (
          <div className="claude-agent-sessions-error">{error}</div>
        )}

        {!isLoading && sessions.length === 0 && !error && (
          <div className="claude-agent-sessions-empty">
            {mode === "thisFile" ? "No sessions for this file" : "No sessions found"}
          </div>
        )}

        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            isActive={session.id === currentSessionId}
            onSwitch={() => handleSwitchSession(session.id)}
            onToggleStatus={() =>
              handleToggleStatus(
                session.id,
                session.status === "done" ? "in_progress" : "done"
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

export class SessionsView extends ItemView {
  private root: Root | null = null;
  private plugin: ClaudeAgentPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SESSIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sessions";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("claude-agent-sessions-view");

    this.root = createRoot(container);
    this.root.render(
      <SessionsContainer plugin={this.plugin} app={this.plugin.app} />
    );
  }

  async onClose(): Promise<void> {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
