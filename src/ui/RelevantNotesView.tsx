import React, { useCallback, useEffect, useRef, useState } from "react";
import { App, ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { useAtomValue } from "jotai";
import { chatStore } from "@/state/chatState";
import {
  relevantNotesAtom,
  searchModeAtom,
  isSearchingNotesAtom,
  indexAvailableAtom,
  relevantNotesErrorAtom,
  setSearchMode,
  setRelevantNotes,
  setSearchingNotes,
  setRelevantNotesError,
  setIndexAvailable,
} from "@/state/relevantNotesState";
import type { SearchMode, ActiveFileContext, RelevantNote } from "@/types";
import { RelevantNoteCard } from "./RelevantNotes/RelevantNoteCard";
import { AgentIndexClient, rankNotes } from "@/embeddings";
import type HermesAgentPlugin from "@/main";
import { AGENT_EVENTS } from "@/events";

export const RELEVANT_NOTES_VIEW_TYPE = "hermes-agent-relevant-notes";

interface RelevantNotesContainerProps {
  plugin: HermesAgentPlugin;
  app: App;
}

function RelevantNotesContainer({ plugin, app }: RelevantNotesContainerProps) {
  const notes = useAtomValue(relevantNotesAtom, { store: chatStore });
  const searchMode = useAtomValue(searchModeAtom, { store: chatStore });
  const isSearching = useAtomValue(isSearchingNotesAtom, { store: chatStore });
  const indexAvailable = useAtomValue(indexAvailableAtom, { store: chatStore });
  const error = useAtomValue(relevantNotesErrorAtom, { store: chatStore });

  const indexClientRef = useRef<AgentIndexClient | null>(null);
  const [activeFile, setActiveFile] = useState<ActiveFileContext | undefined>(undefined);

  // Initialize index client (waits for the bridge to be ready)
  useEffect(() => {
    let cancelled = false;
    const tryInit = async () => {
      for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
        if (plugin.hermesClient) {
          const { bridgeUrl, authToken } = plugin.hermesClient;
          const client = new AgentIndexClient(bridgeUrl, authToken);
          const success = await client.initialize();
          if (success && !cancelled) {
            indexClientRef.current = client;
            setIndexAvailable(true);
            console.log("[RelevantNotesView] Hermes bridge index connected");
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    tryInit();
    return () => { cancelled = true; };
  }, [plugin]);

  // Get current active file
  const getActiveFileContext = useCallback((): ActiveFileContext | undefined => {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) return undefined;
    return {
      path: activeFile.path,
      name: activeFile.name,
      extension: activeFile.extension,
    };
  }, [app]);

  // Update active file when workspace changes
  useEffect(() => {
    const updateActiveFile = () => {
      setActiveFile(getActiveFileContext());
    };

    // Initial set
    updateActiveFile();

    app.workspace.on("active-leaf-change", updateActiveFile);
    return () => {
      app.workspace.off("active-leaf-change", updateActiveFile);
    };
  }, [app, getActiveFileContext]);

  // Search for relevant notes
  const searchRelevantNotes = useCallback(async () => {
    const reader = indexClientRef.current;
    if (!reader || !reader.isInitialized()) return;

    setSearchingNotes(true);
    setRelevantNotesError(null);

    try {
      let results: RelevantNote[] = [];
      if (searchMode === "currentFile" && activeFile) {
        results = await reader.searchSimilarToPath(activeFile.path, {
          minSimilarity: 0.4,
          limit: 10,
        });
      } else if (searchMode === "chatContext") {
        // For chat context mode, fall back to current file for now
        if (activeFile) {
          results = await reader.searchSimilarToPath(activeFile.path, {
            minSimilarity: 0.4,
            limit: 10,
          });
        }
      }

      const ranked = rankNotes(results, activeFile?.path ?? null, app);
      setRelevantNotes(ranked);
    } catch (error) {
      console.error("[RelevantNotesView] Error searching relevant notes:", error);
      setRelevantNotesError("Failed to search for relevant notes");
    } finally {
      setSearchingNotes(false);
    }
  }, [activeFile, searchMode, app]);

  // Trigger search when active file changes or index becomes available
  useEffect(() => {
    if (indexAvailable && activeFile && searchMode === "currentFile") {
      searchRelevantNotes();
    }
  }, [activeFile, searchMode, indexAvailable, searchRelevantNotes]);

  // Handle mode change
  const handleModeChange = (mode: SearchMode) => {
    setSearchMode(mode);
    searchRelevantNotes();
  };

  // Handle adding note to chat via custom event
  const handleAddNoteToChat = useCallback((notePath: string) => {
    window.dispatchEvent(
      new CustomEvent(AGENT_EVENTS.addNoteToChat, { detail: { notePath } })
    );
  }, []);

  // Handle opening a note
  const handleOpenNote = (path: string) => {
    app.workspace.openLinkText(path, "");
  };

  if (!indexAvailable) {
    return (
      <div className="hermes-agent-relevant-notes-standalone">
        <div className="hermes-agent-relevant-notes-empty">
          Index not available. Make sure the Hermes bridge is running and OPENAI_API_KEY is set.
        </div>
      </div>
    );
  }

  return (
    <div className="hermes-agent-relevant-notes-standalone">
      <div className="hermes-agent-relevant-notes-toolbar">
        {/* Mode toggle */}
        <div className="hermes-agent-relevant-notes-mode-toggle">
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
          className={`hermes-agent-relevant-notes-refresh ${isSearching ? "spinning" : ""}`}
          onClick={searchRelevantNotes}
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

      <div className={`hermes-agent-relevant-notes-list ${isSearching ? "searching" : ""}`}>
        {error && (
          <div className="hermes-agent-relevant-notes-error">{error}</div>
        )}

        {!isSearching && notes.length === 0 && !error && (
          <div className="hermes-agent-relevant-notes-empty">
            No relevant notes found
          </div>
        )}

        {notes.map((note) => (
          <RelevantNoteCard
            key={note.path}
            note={note}
            onAddToChat={() => handleAddNoteToChat(note.path)}
            onOpen={() => handleOpenNote(note.path)}
          />
        ))}
      </div>
    </div>
  );
}

export class RelevantNotesView extends ItemView {
  private root: Root | null = null;
  private plugin: HermesAgentPlugin;
  private readonly viewType: string;

  constructor(leaf: WorkspaceLeaf, plugin: HermesAgentPlugin, viewType = RELEVANT_NOTES_VIEW_TYPE) {
    super(leaf);
    this.plugin = plugin;
    this.viewType = viewType;
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return "Relevant Notes";
  }

  getIcon(): string {
    return "files";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("hermes-agent-relevant-notes-view");

    this.root = createRoot(container);
    this.root.render(
      <RelevantNotesContainer plugin={this.plugin} app={this.plugin.app} />
    );
  }

  async onClose(): Promise<void> {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
