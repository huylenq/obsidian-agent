import React, { useCallback, useState, useEffect } from "react";
import { useAtomValue } from "jotai";
import { App, ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { ActiveFileContext } from "@/types";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { ActiveFileChip } from "./ActiveFileChip";
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
} from "@/state/chatState";
import { ChatMessage } from "@/types";
import type ClaudeAgentPlugin from "@/main";

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

function ChatContainer({ plugin, app }: ChatContainerProps) {
  const isLoading = useAtomValue(isLoadingAtom, { store: chatStore });
  const [activeFile, setActiveFile] = useState<ActiveFileContext | undefined>(
    getActiveFileContext(app)
  );
  const [isContextCleared, setIsContextCleared] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(
    plugin.claudeClient?.getSessionId() ?? null
  );

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

  const handleClearContext = useCallback(() => {
    setIsContextCleared(true);
  }, []);

  const handleNewChat = useCallback(() => {
    plugin.claudeClient?.clearSession();
    clearMessages();
    setSessionId(null);
  }, [plugin.claudeClient]);

  const handleSend = useCallback(
    async (message: string, mentionedFiles: FileSearchResult[]) => {
      // Capture active file before sending (use state, respect cleared flag)
      const fileContext = isContextCleared ? undefined : activeFile;

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
        for await (const chunk of plugin.claudeClient.chat(message, fileContext, mentionedFiles)) {
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
    [plugin, activeFile, isContextCleared]
  );

  const showChip = activeFile && !isContextCleared;

  return (
    <div className="claude-agent-container">
      <div className="claude-agent-header">
        <span className="claude-agent-session-info">
          {sessionId ? (
            <span className="claude-agent-session-id" title={sessionId ?? undefined}>
              Session: {sessionId}
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
      <ChatMessages />
      <div className="claude-agent-input-area">
        {showChip && (
          <ActiveFileChip activeFile={activeFile} onClear={handleClearContext} />
        )}
        <ChatInput onSend={handleSend} disabled={isLoading} app={app} />
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
