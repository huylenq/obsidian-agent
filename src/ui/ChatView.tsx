import React, { useCallback, useState, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { App, ItemView, WorkspaceLeaf, MarkdownView, setIcon } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { ActiveFileContext, ClaudeModel, SelectionContext } from "@/types";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { ActiveFileChip } from "./ActiveFileChip";
import { SelectionChip } from "./SelectionChip";
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
  updateToolMessage,
} from "@/state/chatState";
import {
  relevantNotesAtom,
  includeRelevantNotesAtom,
  setIncludeRelevantNotes,
} from "@/state/relevantNotesState";
import { connectionStatusAtom, connectionErrorAtom } from "@/state/connectionState";
import { ChatMessage, CompactMetadata, ToolBlock } from "@/types";
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
  const relevantNotes = useAtomValue(relevantNotesAtom, { store: chatStore });
  const includeRelevantNotes = useAtomValue(includeRelevantNotesAtom, { store: chatStore });
  const connectionStatus = useAtomValue(connectionStatusAtom, { store: chatStore });
  const connectionError = useAtomValue(connectionErrorAtom, { store: chatStore });
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const brainIconRef = useRef<HTMLSpanElement>(null);
  const checkIconRef = useRef<HTMLSpanElement>(null);
  const [inputRef, setInputRef] = useState<ChatInputHandle | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);

  // Listen for command to open model selector
  useEffect(() => {
    const handleOpenSelector = () => {
      modelSelectRef.current?.focus();
      modelSelectRef.current?.showPicker?.();
    };
    window.addEventListener("claude-agent:open-model-selector", handleOpenSelector);
    return () => window.removeEventListener("claude-agent:open-model-selector", handleOpenSelector);
  }, []);

  useEffect(() => {
    if (brainIconRef.current) {
      setIcon(brainIconRef.current, "sparkles");
    }
    if (checkIconRef.current) {
      setIcon(checkIconRef.current, "check");
    }
  }, []);

  // Sync model atom with plugin settings on mount
  useEffect(() => {
    chatStore.set(modelAtom, plugin.settings.model);
  }, [plugin.settings.model]);

  // Sync includeRelevantNotes atom with plugin settings on mount
  useEffect(() => {
    setIncludeRelevantNotes(plugin.settings.includeRelevantNotes);
  }, [plugin.settings.includeRelevantNotes]);

  // Subscribe to session ID changes (also saves settings for persistence)
  useEffect(() => {
    if (plugin.claudeClient) {
      plugin.claudeClient.setOnSessionChange((newSessionId) => {
        setSessionId(newSessionId);
        plugin.saveSettings();
      });
    }
  }, [plugin.claudeClient]);

  // Load history from transcript when view mounts with existing session
  useEffect(() => {
    const loadHistory = async () => {
      if (plugin.initializationPromise) {
        await plugin.initializationPromise;
      }

      if (!plugin.claudeClient) return;

      const currentSessionId = plugin.claudeClient.getSessionId();
      if (!currentSessionId) return;

      const existingMessages = chatStore.get(messagesAtom);
      if (existingMessages.length > 0) return;

      console.log("[ChatView] Loading history for session:", currentSessionId);

      try {
        const historyMessages = await plugin.claudeClient.fetchHistory();
        if (historyMessages.length > 0) {
          const chatMessages: ChatMessage[] = historyMessages.map((msg) => ({
            id: generateMessageId(),
            role: msg.role as ChatMessage["role"],
            content: (msg.content as string) || "",
            timestamp: (msg.timestamp as number) || Date.now(),
            ...((msg.compactMetadata as CompactMetadata) && { compactMetadata: msg.compactMetadata as CompactMetadata }),
            ...((msg.toolBlocks as ToolBlock[]) && { toolBlocks: msg.toolBlocks as ToolBlock[] }),
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
      setIsContextCleared(false);
    };

    app.workspace.on("active-leaf-change", updateActiveFile);
    return () => {
      app.workspace.off("active-leaf-change", updateActiveFile);
    };
  }, [app]);

  // Poll for selection changes (live updating)
  useEffect(() => {
    const checkSelection = () => {
      const activeView = app.workspace.getActiveViewOfType(MarkdownView);
      const editorHasFocus = activeView?.containerEl.contains(document.activeElement);

      const newSelection = getSelectionContext(app);

      setSelection((prev) => {
        if (!newSelection && !editorHasFocus && prev) {
          return prev;
        }
        if (prev?.text !== newSelection?.text || prev?.filePath !== newSelection?.filePath) {
          return newSelection;
        }
        return prev;
      });
    };

    checkSelection();
    const intervalId = setInterval(checkSelection, 200);
    return () => { clearInterval(intervalId); };
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
    setSessionTitle(null);
    // Notify SessionsView
    window.dispatchEvent(new CustomEvent("claude-agent:session-changed", { detail: { sessionId: null } }));
    window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));
  }, [plugin.claudeClient]);

  // Initialize slash commands
  useEffect(() => {
    initializeCommands();
  }, []);

  // Listen for "add note to chat" events from RelevantNotesView
  useEffect(() => {
    const handleAddNoteToChat = (event: CustomEvent<{ notePath: string }>) => {
      if (inputRef?.insertMention) {
        inputRef.insertMention(event.detail.notePath);
      }
    };

    window.addEventListener(
      "claude-agent:add-note-to-chat",
      handleAddNoteToChat as EventListener
    );
    return () => {
      window.removeEventListener(
        "claude-agent:add-note-to-chat",
        handleAddNoteToChat as EventListener
      );
    };
  }, [inputRef]);

  // Listen for "switch session" events from SessionsView
  useEffect(() => {
    const handleSwitchSession = async (event: CustomEvent<{ sessionId: string }>) => {
      const targetSessionId = event.detail.sessionId;
      if (!plugin.claudeClient) return;

      clearMessages();
      plugin.claudeClient.switchSession(targetSessionId);
      setSessionId(targetSessionId);

      // Load history for the switched session
      try {
        const historyMessages = await plugin.claudeClient.fetchHistory();
        if (historyMessages.length > 0) {
          const chatMessages: ChatMessage[] = historyMessages.map((msg) => ({
            id: generateMessageId(),
            role: msg.role as ChatMessage["role"],
            content: (msg.content as string) || "",
            timestamp: (msg.timestamp as number) || Date.now(),
            ...((msg.compactMetadata as CompactMetadata) && { compactMetadata: msg.compactMetadata as CompactMetadata }),
            ...((msg.toolBlocks as ToolBlock[]) && { toolBlocks: msg.toolBlocks as ToolBlock[] }),
          }));
          chatStore.set(messagesAtom, chatMessages);
        }
      } catch (error) {
        console.warn("[ChatView] Failed to load session history:", error);
      }
    };

    window.addEventListener("claude-agent:switch-session", handleSwitchSession as EventListener);
    return () => window.removeEventListener("claude-agent:switch-session", handleSwitchSession as EventListener);
  }, [plugin.claudeClient]);

  // Resolve session title from registry when sessionId changes
  useEffect(() => {
    if (!sessionId || !plugin.claudeClient) {
      setSessionTitle(null);
      return;
    }
    // Fetch from server — no dependency on sessionsAtom in this view
    plugin.claudeClient.fetchSessions({ status: "all" }).then((sessions) => {
      const entry = sessions.find(s => s.id === sessionId);
      setSessionTitle(entry?.title || null);
    });
  }, [sessionId, plugin.claudeClient]);

  const handleMarkDone = useCallback(async () => {
    if (!plugin.claudeClient || !sessionId) return;
    await plugin.claudeClient.updateSession(sessionId, { status: "done" });
    plugin.claudeClient.clearSession();
    clearMessages();
    setSessionId(null);
    setSessionTitle(null);
    window.dispatchEvent(new CustomEvent("claude-agent:session-changed", { detail: { sessionId: null } }));
    window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));
  }, [plugin.claudeClient, sessionId]);

  const handleSend = useCallback(
    async (message: string, mentionedFiles: FileSearchResult[]) => {
      const fileContext = isContextCleared ? undefined : activeFile;
      const selectionContext = selection;

      if (!message.startsWith("/")) {
        addMessage({
          id: generateMessageId(),
          role: "user",
          content: message,
          timestamp: Date.now(),
        });
      }

      setLoading(true);
      setError(null);
      clearStreamingMessage();

      setIsContextCleared(false);
      setSelection(undefined);

      try {
        if (plugin.initializationPromise) {
          await plugin.initializationPromise;
        }

        if (!plugin.claudeClient) {
          throw new Error(
            "Claude client is not initialized. Please check that the proxy server is running."
          );
        }

        const highMatchNotes = includeRelevantNotes
          ? relevantNotes.filter(note => note.category === "high" || note.finalScore > 0.7)
          : undefined;

        let fullResponse = "";

        // Helper: flush accumulated text as a permanent assistant message
        const flushText = () => {
          if (fullResponse) {
            clearStreamingMessage();
            addMessage({
              id: generateMessageId(),
              role: "assistant",
              content: fullResponse,
              timestamp: Date.now(),
            });
            fullResponse = "";
          }
        };

        for await (const chunk of plugin.claudeClient.chat(message, fileContext, mentionedFiles, selectionContext, highMatchNotes)) {
          switch (chunk.type) {
            case "text":
              fullResponse = chunk.content;
              updateStreamingMessage(fullResponse);
              break;

            case "tool_use":
              // Flush any accumulated text before showing tool block
              flushText();
              addMessage({
                id: generateMessageId(),
                role: "tool_block",
                content: "",
                timestamp: Date.now(),
                toolBlocks: [{
                  toolUseId: chunk.toolUseId!,
                  toolName: chunk.toolName!,
                  description: chunk.description || chunk.toolName!,
                  input: chunk.input,
                  isRunning: true,
                }],
              });
              break;

            case "tool_result":
              updateToolMessage(
                chunk.toolUseId!,
                chunk.content,
                chunk.isError || false,
              );
              break;

            case "compact_boundary":
              addMessage({
                id: generateMessageId(),
                role: "compact_boundary",
                content: "",
                timestamp: Date.now(),
                compactMetadata: {
                  preTokens: chunk.compactMetadata?.preTokens || 0,
                  trigger: chunk.compactMetadata?.trigger || "manual",
                  summary: chunk.compactMetadata?.summary,
                },
              });
              break;

            case "result":
              // Metadata about the completed query (optional future use)
              break;

            case "error":
              setError(chunk.content || "Unknown error (no details from server)");
              break;

            case "done":
              if (fullResponse && !/^compacted$/i.test(fullResponse.trim())) {
                clearStreamingMessage();
                addMessage({
                  id: generateMessageId(),
                  role: "assistant",
                  content: fullResponse,
                  timestamp: Date.now(),
                });
                fullResponse = "";
              } else {
                clearStreamingMessage();
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
        // Notify SessionsView to refresh (new session may have been created)
        window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));
        window.dispatchEvent(new CustomEvent("claude-agent:session-changed", { detail: { sessionId: plugin.claudeClient?.getSessionId() ?? null } }));
      }
    },
    [plugin, activeFile, isContextCleared, selection, includeRelevantNotes, relevantNotes]
  );

  const handleCommand = useCallback(
    async (commandName: string, args: string) => {
      if (commandName === "compact") {
        await handleSend("/compact", []);
        return;
      }

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
        if (commandName === "clear" || commandName === "new" || commandName === "reset" || commandName === "done") {
          setSessionId(null);
          setSessionTitle(null);
          window.dispatchEvent(new CustomEvent("claude-agent:session-changed", { detail: { sessionId: null } }));
          window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));
        }
        if (commandName === "sessions" || commandName === "history") {
          window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Command failed";
        setError(errorMessage);
      }
    },
    [plugin, app, handleSend]
  );

  // Listen for programmatic send-message events (e.g. from flashcard explain deeplink)
  useEffect(() => {
    const handleSendMessage = (event: CustomEvent<{ message: string }>) => {
      const { message } = event.detail;
      if (message) {
        handleSend(message, []);
      }
    };
    window.addEventListener("claude-agent:send-message", handleSendMessage as EventListener);
    return () => window.removeEventListener("claude-agent:send-message", handleSendMessage as EventListener);
  }, [handleSend]);

  const handleModelChange = useCallback((newModel: ClaudeModel) => {
    chatStore.set(modelAtom, newModel);
    plugin.settings.model = newModel;
    plugin.saveSettings();
    window.dispatchEvent(new CustomEvent("claude-agent:focus-input"));
  }, [plugin]);

  const handleIncludeNotesChange = useCallback((enabled: boolean) => {
    setIncludeRelevantNotes(enabled);
    plugin.settings.includeRelevantNotes = enabled;
    plugin.saveSettings();
  }, [plugin]);

  const showFileChip = activeFile && !isContextCleared;
  const showSelectionChip = selection !== undefined;

  return (
    <div className="claude-agent-container">
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
          <span ref={brainIconRef} className="claude-agent-model-icon" />
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
          <span
            className={`claude-agent-include-notes-toggle ${includeRelevantNotes ? "active" : ""}`}
            onClick={() => !isLoading && handleIncludeNotesChange(!includeRelevantNotes)}
          >
            <span ref={checkIconRef} className="claude-agent-include-notes-check" />
            Include relevances
          </span>
          <div className={`claude-agent-connection-status ${connectionStatus}`} title={
            connectionError || (connectionStatus === "connected" ? "Connected to server" : connectionStatus === "connecting" ? "Connecting..." : connectionStatus === "error" ? "Connection error" : "Disconnected")
          }>
            <span className="claude-agent-connection-dot" />
          </div>
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

    this.root = createRoot(container);
    this.root.render(<ChatContainer plugin={this.plugin} app={this.plugin.app} />);
  }

  async onClose(): Promise<void> {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
