import React, { useCallback, useEffect, useState } from "react";
import { App, ItemView, WorkspaceLeaf } from "obsidian";
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
          <button
            className={mode === "thisFile" ? "active" : ""}
            onClick={() => handleModeChange("thisFile")}
            title="Sessions for current file"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </button>
          <button
            className={mode === "all" ? "active" : ""}
            onClick={() => handleModeChange("all")}
            title="All sessions"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </button>
        </div>

        {/* Status filter */}
        <button
          className="claude-agent-sessions-status-filter"
          onClick={handleStatusFilterChange}
          title={statusFilter === "in_progress" ? "Showing in-progress only" : "Showing all"}
        >
          {statusFilter === "in_progress" ? "Active" : "All"}
        </button>

        {/* Refresh */}
        <button
          className={`claude-agent-sessions-refresh ${isLoading ? "spinning" : ""}`}
          onClick={fetchSessions}
          title="Refresh sessions"
          disabled={isLoading}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
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
