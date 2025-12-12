import React, { useCallback, useState, useEffect } from "react";
import { useAtomValue } from "jotai";
import { App, ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { ActiveFileContext } from "@/types";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { ActiveFileChip } from "./ActiveFileChip";
import {
  addMessage,
  updateStreamingMessage,
  clearStreamingMessage,
  setLoading,
  setError,
  isLoadingAtom,
  chatStore,
  generateMessageId,
} from "@/state/chatState";
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

  const handleSend = useCallback(
    async (message: string) => {
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
        // Ensure client is initialized
        if (!plugin.claudeClient) {
          throw new Error(
            "Claude client is not initialized. Please check that:\n" +
            "1. Copilot plugin is installed and configured\n" +
            "2. Copilot has indexed your vault (run 'Index vault for QA')\n" +
            "3. An embedding API key is configured in Copilot"
          );
        }

        let fullResponse = "";

        // Stream the response
        for await (const chunk of plugin.claudeClient.chat(message, fileContext)) {
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
      <ChatMessages />
      <div className="claude-agent-input-area">
        {showChip && (
          <ActiveFileChip activeFile={activeFile} onClear={handleClearContext} />
        )}
        <ChatInput onSend={handleSend} disabled={isLoading} />
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
