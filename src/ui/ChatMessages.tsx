import React, { useEffect, useRef, useState, useMemo } from "react";
import { useAtomValue } from "jotai";
import {
  messagesAtom,
  streamingMessageAtom,
  isLoadingAtom,
  errorAtom,
  chatStore,
} from "@/state/chatState";
import { MarkdownContent } from "./MarkdownContent";
import { ToolCallBlock } from "./ToolCallBlock";
import { ChatMessage } from "@/types";

interface MessageGroup {
  messages: ChatMessage[];
  boundary?: ChatMessage;
}

function groupMessagesByBoundary(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let current: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "compact_boundary") {
      groups.push({ messages: current, boundary: msg });
      current = [];
    } else {
      current.push(msg);
    }
  }

  // Final group (no boundary after it — the active segment)
  groups.push({ messages: current });
  return groups;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return String(tokens);
}

function CompactBoundary({
  boundary,
  messageCount,
  isCollapsed,
  onToggle,
}: {
  boundary: ChatMessage;
  messageCount: number;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const meta = boundary.compactMetadata;
  const tokenLabel = meta ? formatTokenCount(meta.preTokens) : "?";
  const summary = meta?.summary;
  const sdkSummary = meta?.sdkSummary;

  return (
    <div className="claude-agent-compact-boundary" onClick={onToggle}>
      <div className="claude-agent-compact-boundary-line" />
      <div className="claude-agent-compact-boundary-header">
        <span className={`claude-agent-compact-chevron ${isCollapsed ? "" : "expanded"}`}>
          &#9656;
        </span>
        <span className="claude-agent-compact-label">
          {messageCount} messages compacted ({tokenLabel} tokens)
        </span>
      </div>
      {summary && (
        <div className="claude-agent-compact-summary">{summary}</div>
      )}
      {sdkSummary && (
        <div className="claude-agent-compact-sdk-summary" onClick={(e) => e.stopPropagation()}>
          <MarkdownContent content={sdkSummary} className="claude-agent-compact-sdk-summary-content" />
        </div>
      )}
      <div className="claude-agent-compact-boundary-line" />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "tool_block" && message.toolBlocks) {
    return (
      <div className="claude-agent-message tool_block">
        {message.toolBlocks.map((block) => (
          <ToolCallBlock key={block.toolUseId} block={block} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`claude-agent-message ${message.role} ${message.toolName ? "tool-call" : ""}`}
    >
      {message.toolName && (
        <div className="claude-agent-tool-label">
          {message.toolName}
        </div>
      )}
      <MarkdownContent
        content={message.content}
        className="claude-agent-message-content"
      />
    </div>
  );
}

export function ChatMessages() {
  const messages = useAtomValue(messagesAtom, { store: chatStore });
  const streamingMessage = useAtomValue(streamingMessageAtom, { store: chatStore });
  const isLoading = useAtomValue(isLoadingAtom, { store: chatStore });
  const error = useAtomValue(errorAtom, { store: chatStore });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupMessagesByBoundary(messages), [messages]);

  // Collapsed state: all compacted groups start collapsed
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());

  const toggleGroup = (index: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

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
      {groups.map((group, groupIndex) => {
        const hasBoundary = !!group.boundary;
        const isCollapsed = hasBoundary && !expandedGroups.has(groupIndex);

        return (
          <React.Fragment key={groupIndex}>
            {/* Messages in this group */}
            {!isCollapsed &&
              group.messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}

            {/* Compact boundary divider */}
            {hasBoundary && (
              <CompactBoundary
                boundary={group.boundary!}
                messageCount={group.messages.length}
                isCollapsed={isCollapsed}
                onToggle={() => toggleGroup(groupIndex)}
              />
            )}
          </React.Fragment>
        );
      })}

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
