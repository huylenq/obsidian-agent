import React, { useCallback } from "react";
import { useAtomValue } from "jotai";
import { ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
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
}

function ChatContainer({ plugin }: ChatContainerProps) {
  const isLoading = useAtomValue(isLoadingAtom, { store: chatStore });

  const handleSend = useCallback(
    async (message: string) => {
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
        for await (const chunk of plugin.claudeClient.chat(message)) {
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
    [plugin]
  );

  return (
    <div className="claude-agent-container">
      <ChatMessages />
      <ChatInput onSend={handleSend} disabled={isLoading} />
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
    this.root.render(<ChatContainer plugin={this.plugin} />);
  }

  async onClose(): Promise<void> {
    // Cleanup React root
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
