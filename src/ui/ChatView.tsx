import React, { useCallback, useState, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { App, ItemView, WorkspaceLeaf, MarkdownView } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { ActiveFileContext, ClaudeModel, SelectionContext, RelevantNote } from "@/types";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { ActiveFileChip } from "./ActiveFileChip";
import { SelectionChip } from "./SelectionChip";
import { RelevantNotes } from "./RelevantNotes";
import { FileSearchResult } from "@/utils/fileSearch";
import {
  addMessage,
  updateStreamingMessage,
  clearStreamingMessage,
  setLoading,
  setError,
  isLoadingAtom,
  chatStore,
  generateMessageId,
  clearMessages,
  messagesAtom,
  modelAtom,
} from "@/state/chatState";
import {
  setRelevantNotes,
  setSearchingNotes,
  setIndexAvailable,
  setRelevantNotesError,
  searchModeAtom,
} from "@/state/relevantNotesState";
import { CopilotIndexReader, rankNotes } from "@/embeddings";
import { ChatMessage } from "@/types";
import type ClaudeAgentPlugin from "@/main";
import { initializeCommands, commandRegistry, CommandContext } from "@/commands";

export const CHAT_VIEW_TYPE = "claude-agent-chat";

interface ChatContainerProps {
  plugin: ClaudeAgentPlugin;
  app: App;
}

function getActiveFileContext(app: App): ActiveFileContext | undefined {
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile) return undefined;

  return {
    path: activeFile.path,
    name: activeFile.name,
    extension: activeFile.extension,
  };
}

function getSelectionContext(app: App): SelectionContext | undefined {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const editor = view?.editor;
  const selection = editor?.getSelection();

  if (!selection || selection.trim() === "") return undefined;

  const file = view?.file;
  if (!file) return undefined;

  const from = editor?.getCursor("from");
  const to = editor?.getCursor("to");

  return {
    text: selection,
    filePath: file.path,
    fileName: file.name,
    startLine: from?.line !== undefined ? from.line + 1 : undefined,
    endLine: to?.line !== undefined ? to.line + 1 : undefined,
  };
}

function ChatContainer({ plugin, app }: ChatContainerProps) {
  const isLoading = useAtomValue(isLoadingAtom, { store: chatStore });
  const [activeFile, setActiveFile] = useState<ActiveFileContext | undefined>(
    getActiveFileContext(app)
  );
  const [isContextCleared, setIsContextCleared] = useState(false);
  const [selection, setSelection] = useState<SelectionContext | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | null>(
    plugin.claudeClient?.getSessionId() ?? null
  );
  const model = useAtomValue(modelAtom, { store: chatStore });
  const searchMode = useAtomValue(searchModeAtom, { store: chatStore });
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const indexReaderRef = useRef<CopilotIndexReader | null>(null);
  const [inputRef, setInputRef] = useState<ChatInputHandle | null>(null);

  // Listen for command to open model selector
  useEffect(() => {
    const handleOpenSelector = () => {
      modelSelectRef.current?.focus();
      modelSelectRef.current?.showPicker?.();
    };
    window.addEventListener("claude-agent:open-model-selector", handleOpenSelector);
    return () => window.removeEventListener("claude-agent:open-model-selector", handleOpenSelector);
  }, []);

  // Sync model atom with plugin settings on mount
  useEffect(() => {
    chatStore.set(modelAtom, plugin.settings.model);
  }, [plugin.settings.model]);

  // Subscribe to session ID changes (also saves settings for persistence)
  useEffect(() => {
    if (plugin.claudeClient) {
      plugin.claudeClient.setOnSessionChange((newSessionId) => {
        setSessionId(newSessionId);
        // Important: Also save to disk so session persists across restarts
        plugin.saveSettings();
      });
    }
  }, [plugin.claudeClient]);

  // Load history from transcript when view mounts with existing session
  useEffect(() => {
    const loadHistory = async () => {
      // Wait for plugin initialization
      if (plugin.initializationPromise) {
        await plugin.initializationPromise;
      }

      if (!plugin.claudeClient) return;

      const currentSessionId = plugin.claudeClient.getSessionId();
      if (!currentSessionId) return;

      // Check if we already have messages (don't reload if already populated)
      const existingMessages = chatStore.get(messagesAtom);
      if (existingMessages.length > 0) return;

      console.log("[ChatView] Loading history for session:", currentSessionId);

      try {
        const historyMessages = await plugin.claudeClient.fetchHistory();
        if (historyMessages.length > 0) {
          const chatMessages: ChatMessage[] = historyMessages.map((msg) => ({
            id: generateMessageId(),
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
          }));
          chatStore.set(messagesAtom, chatMessages);
          console.log("[ChatView] Loaded", chatMessages.length, "history messages");
        }
      } catch (error) {
        console.warn("[ChatView] Failed to load history:", error);
      }
    };

    loadHistory();
  }, [plugin]);

  // Update active file when workspace active leaf changes
  useEffect(() => {
    const updateActiveFile = () => {
      const newActiveFile = getActiveFileContext(app);
      setActiveFile(newActiveFile);
      setIsContextCleared(false); // Reset cleared state when file changes
    };

    app.workspace.on("active-leaf-change", updateActiveFile);
    return () => {
      app.workspace.off("active-leaf-change", updateActiveFile);
    };
  }, [app]);

  // Poll for selection changes (live updating)
  useEffect(() => {
    const checkSelection = () => {
      const newSelection = getSelectionContext(app);
      setSelection((prev) => {
        // Only update if selection text changed
        if (prev?.text !== newSelection?.text || prev?.filePath !== newSelection?.filePath) {
          return newSelection;
        }
        return prev;
      });
    };

    // Initial check
    checkSelection();

    // Poll every 200ms for selection changes
    const intervalId = setInterval(checkSelection, 200);

    return () => {
      clearInterval(intervalId);
    };
  }, [app]);

  const handleClearContext = useCallback(() => {
    setIsContextCleared(true);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelection(undefined);
  }, []);

  const handleNewChat = useCallback(() => {
    plugin.claudeClient?.clearSession();
    clearMessages();
    setSessionId(null);
  }, [plugin.claudeClient]);

  // Initialize slash commands
  useEffect(() => {
    initializeCommands();
  }, []);

  // Initialize Copilot index reader
  useEffect(() => {
    const initIndex = async () => {
      const reader = new CopilotIndexReader(app);
      const success = await reader.initialize();
      indexReaderRef.current = reader;
      setIndexAvailable(success);
      if (success) {
        console.log("[ChatView] Copilot index loaded successfully");
      }
    };
    initIndex();
  }, [app]);

  // Search for relevant notes when active file changes or search mode changes
  const searchRelevantNotes = useCallback(async () => {
    const reader = indexReaderRef.current;
    if (!reader || !reader.isInitialized()) return;

    setSearchingNotes(true);
    setRelevantNotesError(null);

    try {
      let results: RelevantNote[] = [];
      if (searchMode === "currentFile" && activeFile) {
        // Search based on current file
        results = await reader.searchSimilarToPath(activeFile.path, {
          minSimilarity: 0.4,
          limit: 10,
        });
      } else if (searchMode === "chatContext") {
        // For chat context mode, we'd need to get embeddings for chat messages
        // For now, fall back to current file if available
        if (activeFile) {
          results = await reader.searchSimilarToPath(activeFile.path, {
            minSimilarity: 0.4,
            limit: 10,
          });
        }
      }

      // Rank results with link weighting
      const ranked = rankNotes(results, activeFile?.path ?? null, app);
      setRelevantNotes(ranked);
    } catch (error) {
      console.error("[ChatView] Error searching relevant notes:", error);
      setRelevantNotesError("Failed to search for relevant notes");
    } finally {
      setSearchingNotes(false);
    }
  }, [activeFile, searchMode, app]);

  // Trigger search when active file changes
  useEffect(() => {
    if (activeFile && searchMode === "currentFile") {
      searchRelevantNotes();
    }
  }, [activeFile, searchMode, searchRelevantNotes]);

  // Handle adding a note to chat as @mention
  const handleAddNoteToChat = useCallback((notePath: string) => {
    if (inputRef?.insertMention) {
      inputRef.insertMention(notePath);
    }
  }, [inputRef]);

  const handleCommand = useCallback(
    async (commandName: string, args: string) => {
      const command = commandRegistry.get(commandName);

      if (!command) {
        setError(`Unknown command: /${commandName}`);
        return;
      }

      const context: CommandContext = {
        plugin,
        app,
        clearMessages,
      };

      try {
        const result = await command.execute(context, args);
        if (!result.silent && result.message) {
          addMessage({
            id: generateMessageId(),
            role: "assistant",
            content: result.message,
            timestamp: Date.now(),
          });
        }
        // Update local session state if it was a clear command
        if (commandName === "clear" || commandName === "new" || commandName === "reset") {
          setSessionId(null);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Command failed";
        setError(errorMessage);
      }
    },
    [plugin, app]
  );

  const handleModelChange = useCallback((newModel: ClaudeModel) => {
    chatStore.set(modelAtom, newModel);
    plugin.settings.model = newModel;
    plugin.saveSettings();
    // Return focus to input
    window.dispatchEvent(new CustomEvent("claude-agent:focus-input"));
  }, [plugin]);

  const handleSend = useCallback(
    async (message: string, mentionedFiles: FileSearchResult[]) => {
      // Capture context before sending
      const fileContext = isContextCleared ? undefined : activeFile;
      const selectionContext = selection;

      // Add user message
      addMessage({
        id: generateMessageId(),
        role: "user",
        content: message,
        timestamp: Date.now(),
      });

      setLoading(true);
      setError(null);
      clearStreamingMessage();

      // Reset cleared state after sending
      setIsContextCleared(false);
      // Auto-clear selection after sending
      setSelection(undefined);

      try {
        // Wait for plugin initialization to complete (handles race with view restoration)
        if (plugin.initializationPromise) {
          await plugin.initializationPromise;
        }

        // Ensure client is initialized
        if (!plugin.claudeClient) {
          throw new Error(
            "Claude client is not initialized. Please check that the proxy server is running."
          );
        }

        let fullResponse = "";

        // Stream the response
        for await (const chunk of plugin.claudeClient.chat(message, fileContext, mentionedFiles, selectionContext)) {
          switch (chunk.type) {
            case "text":
              // chunk.content is the full accumulated text, not a delta
              fullResponse = chunk.content;
              updateStreamingMessage(fullResponse);
              break;

            case "tool_call":
              // Optionally show tool calls
              if (plugin.settings.showDebugInfo) {
                addMessage({
                  id: generateMessageId(),
                  role: "tool",
                  content: chunk.content,
                  timestamp: Date.now(),
                  toolName: chunk.toolName,
                });
              }
              break;

            case "error":
              setError(chunk.content);
              break;

            case "done":
              // Add the complete assistant message
              if (fullResponse) {
                clearStreamingMessage();
                addMessage({
                  id: generateMessageId(),
                  role: "assistant",
                  content: fullResponse,
                  timestamp: Date.now(),
                });
              }
              break;
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        setError(errorMessage);
        console.error("Chat error:", error);
      } finally {
        setLoading(false);
      }
    },
    [plugin, activeFile, isContextCleared, selection]
  );

  const showFileChip = activeFile && !isContextCleared;
  const showSelectionChip = selection !== undefined;

  return (
    <div className="claude-agent-container">
      <div className="claude-agent-header">
        <span className="claude-agent-session-info">
          {sessionId ? (
            <span className="claude-agent-session-id" title={sessionId ?? undefined}>
              {sessionId}
            </span>
          ) : (
            <span className="claude-agent-session-id claude-agent-session-new">
              New session
            </span>
          )}
        </span>
        <button
          className="claude-agent-new-chat-button"
          onClick={handleNewChat}
          disabled={isLoading}
          title="Start new chat"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <RelevantNotes
        app={app}
        onAddToChat={handleAddNoteToChat}
        onRefresh={searchRelevantNotes}
      />
      <ChatMessages />
      <div className="claude-agent-input-area">
        {(showFileChip || showSelectionChip) && (
          <div className="claude-agent-context-chips">
            {showFileChip && (
              <ActiveFileChip activeFile={activeFile} onClear={handleClearContext} />
            )}
            {showSelectionChip && (
              <SelectionChip selection={selection} onClear={handleClearSelection} />
            )}
          </div>
        )}
        <ChatInput
          onSend={handleSend}
          onCommand={handleCommand}
          disabled={isLoading}
          app={app}
          onRef={setInputRef}
        />
        <div className="claude-agent-input-footer">
          <select
            ref={modelSelectRef}
            className="claude-agent-model-select"
            value={model}
            onChange={(e) => handleModelChange(e.target.value as ClaudeModel)}
            disabled={isLoading}
          >
            <option value="haiku">Haiku</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
        </div>
      </div>
    </div>
  );
}

export class ClaudeAgentChatView extends ItemView {
  private root: Root | null = null;
  private plugin: ClaudeAgentPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Claude Agent";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();

    // Create React root and render
    this.root = createRoot(container);
    this.root.render(<ChatContainer plugin={this.plugin} app={this.plugin.app} />);
  }

  async onClose(): Promise<void> {
    // Cleanup React root
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
