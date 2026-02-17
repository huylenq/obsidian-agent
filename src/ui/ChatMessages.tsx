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
    if (msg.role === "compact_boundary" || msg.role === "thread_boundary") {
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

function ThreadBoundary({
  boundary,
}: {
  boundary: ChatMessage;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const meta = boundary.threadMetadata;
  if (!meta) return null;

  const truncatedQuestion = meta.question.length > 80
    ? meta.question.slice(0, 77) + "..."
    : meta.question;

  const navigateToFlashcard = () => {
    if (!meta.sourceFile || !meta.flashcardId) return;
    window.dispatchEvent(new CustomEvent("flashcard:navigate", {
      detail: { sourceFile: meta.sourceFile, flashcardId: meta.flashcardId },
    }));
  };

  return (
    <div className="claude-agent-thread-boundary" data-flashcard-id={meta.flashcardId}>
      <div className="claude-agent-thread-boundary-line" />
      <div className="claude-agent-thread-boundary-header">
        <span
          className="claude-agent-thread-label"
          onClick={navigateToFlashcard}
          title="Go to flashcard"
        >
          {truncatedQuestion || "Flashcard"}
        </span>
        {meta.sourceFile && (
          <span
            className="claude-agent-thread-source"
            onClick={navigateToFlashcard}
            title={meta.sourceFile}
          >
            {meta.sourceFile.split("/").pop()?.replace(/\.md$/, "") || meta.sourceFile}
          </span>
        )}
      </div>
      <div className="claude-agent-thread-boundary-line" />
    </div>
  );
}

const FLASHCARD_PREFIX = "Explain this flashcard.";
const FLASHCARD_RE = /\*\*Question:\*\*\n([\s\S]*?)\n\n\*\*Answer:\*\*\n([\s\S]*?)(?:\n\n\*\*Context:\*\*\n([\s\S]*))?$/;

/**
 * Parse a flashcard explain prompt into question/answer/context.
 * Returns null if content doesn't match the expected pattern.
 */
function parseFlashcardContent(content: string): { question: string; answer: string; context?: string } | null {
  if (!content.startsWith(FLASHCARD_PREFIX)) return null;
  const m = content.match(FLASHCARD_RE);
  if (!m) return null;
  return {
    question: m[1].trim(),
    answer: m[2].trim(),
    context: m[3]?.trim() || undefined,
  };
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

  // Detect flashcard explain from content pattern (works for both live and history)
  if (message.role === "user") {
    const fc = parseFlashcardContent(message.content);
    if (fc) {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 0, alignSelf: "flex-end", marginLeft: "auto", maxWidth: "85%" }}>
          <span className="claude-agent-fc-delta">{"\u0394"}</span>
          <div className="claude-agent-message user" style={{ padding: 0, flex: 1, minWidth: 0, marginLeft: '1rem' }}>
            <div style={{ padding: "10px 14px 8px" }}
              dangerouslySetInnerHTML={{ __html: fc.question }} />
            <div style={{ height: 1, margin: "0 14px", background: "currentColor", opacity: 0.15 }} />
            <div style={{ padding: "8px 14px 10px", opacity: 0.75, fontSize: "0.9em" }}
              dangerouslySetInnerHTML={{ __html: fc.answer }} />
          </div>
        </div>
      );
    }
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

interface ChatMessagesProps {
  pendingScrollFlashcardId?: string | null;
  onScrollComplete?: () => void;
}

export function ChatMessages({ pendingScrollFlashcardId, onScrollComplete }: ChatMessagesProps) {
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

  // Scroll to existing flashcard thread (dedup)
  useEffect(() => {
    if (!pendingScrollFlashcardId) return;

    const elements = document.querySelectorAll<HTMLElement>(
      `[data-flashcard-id="${CSS.escape(pendingScrollFlashcardId)}"]`
    );
    if (elements.length === 0) return; // messages still loading — re-fires on next change

    const target = elements[elements.length - 1];
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("claude-agent-thread-highlight");
    target.addEventListener("animationend", () => {
      target.classList.remove("claude-agent-thread-highlight");
    }, { once: true });
    onScrollComplete?.();
  }, [messages, pendingScrollFlashcardId]);

  // Safety net: clear stale pending scroll after 5s
  useEffect(() => {
    if (!pendingScrollFlashcardId) return;
    const timer = setTimeout(() => onScrollComplete?.(), 5000);
    return () => clearTimeout(timer);
  }, [pendingScrollFlashcardId]);

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
        const isThread = hasBoundary && group.boundary!.role === "thread_boundary";
        const isCompact = hasBoundary && group.boundary!.role === "compact_boundary";
        const isCollapsed = isCompact && !expandedGroups.has(groupIndex);

        return (
          <React.Fragment key={groupIndex}>
            {/* Messages in this group */}
            {!isCollapsed &&
              group.messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}

            {/* Thread boundary — rendered AFTER group messages because the
                grouping assigns the boundary to the preceding messages.
                Visually this places the marker between this group and the next. */}
            {isThread && (
              <ThreadBoundary
                boundary={group.boundary!}
                isCollapsed={false}
                onToggle={() => toggleGroup(groupIndex)}
              />
            )}

            {/* Compact boundary divider */}
            {isCompact && (
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
