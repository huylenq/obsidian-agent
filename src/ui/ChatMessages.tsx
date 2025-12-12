import React, { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import {
  messagesAtom,
  streamingMessageAtom,
  isLoadingAtom,
  errorAtom,
  chatStore,
} from "@/state/chatState";
import { MarkdownContent } from "./MarkdownContent";

export function ChatMessages() {
  const messages = useAtomValue(messagesAtom, { store: chatStore });
  const streamingMessage = useAtomValue(streamingMessageAtom, { store: chatStore });
  const isLoading = useAtomValue(isLoadingAtom, { store: chatStore });
  const error = useAtomValue(errorAtom, { store: chatStore });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingMessage]);

  if (messages.length === 0 && !streamingMessage && !isLoading) {
    return (
      <div className="claude-agent-empty-state">
        <h3>Chat with your vault</h3>
        <p>Ask questions about your notes and Claude will search and answer based on your knowledge base.</p>
      </div>
    );
  }

  return (
    <div className="claude-agent-messages">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`claude-agent-message ${message.role} ${message.toolName ? "tool-call" : ""}`}
        >
          {message.toolName && (
            <div className="claude-agent-tool-label">
              🔧 {message.toolName}
            </div>
          )}
          <MarkdownContent
            content={message.content}
            className="claude-agent-message-content"
          />
        </div>
      ))}

      {/* Streaming message */}
      {streamingMessage && (
        <div className="claude-agent-message assistant">
          <MarkdownContent
            content={streamingMessage}
            className="claude-agent-message-content"
          />
        </div>
      )}

      {/* Loading indicator */}
      {isLoading && !streamingMessage && (
        <div className="claude-agent-loading">
          <div className="claude-agent-loading-dots">
            <div className="claude-agent-loading-dot"></div>
            <div className="claude-agent-loading-dot"></div>
            <div className="claude-agent-loading-dot"></div>
          </div>
          <span>Claude is thinking...</span>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="claude-agent-message error">
          <strong>Error:</strong> {error}
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
