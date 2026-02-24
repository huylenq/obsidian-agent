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

const FLASHCARD_PREFIX = "Explain this flashcard.";
const FLASHCARD_RE = /\*\*Question:\*\*\n([\s\S]*?)\n\n\*\*Answer:\*\*\n([\s\S]*?)(?:\n\n\*\*Context:\*\*\n([\s\S]*))?$/;

/**
 * Collapse single-character-per-line sequences produced by Anki's MathJax
 * text extraction (each Unicode math char ends up on its own line).
 */
function collapseMathLines(s: string): string {
  // Replace runs of "single-char\n" into a joined string.
  // Matches: a single non-whitespace char followed by \n, repeated 2+ times.
  return s.replace(/(?:^|\n)((?:.\n){2,})/gm, (_match, group: string) => {
    return group.replace(/\n/g, '');
  });
}

/**
 * Parse a flashcard explain prompt into question/answer/context.
 * Returns null if content doesn't match the expected pattern.
 */
function parseFlashcardContent(content: string): { question: string; answer: string; context?: string } | null {
  if (!content.startsWith(FLASHCARD_PREFIX)) return null;
  const m = content.match(FLASHCARD_RE);
  if (!m) return null;
  return {
    question: collapseMathLines(m[1].trim()),
    answer: collapseMathLines(m[2].trim()),
    context: m[3]?.trim() || undefined,
  };
}

function FlashcardBubble({ fc, rawContent, flashcardId, canNavigate, onNavigate }: {
  fc: { question: string; answer: string; context?: string };
  rawContent: string;
  flashcardId?: string;
  canNavigate: boolean;
  onNavigate: () => void;
}) {
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <div
      className="claude-agent-fc-row"
      data-flashcard-id={flashcardId}
    >
      <div className="claude-agent-fc-card-row">
        <span
          className={`claude-agent-fc-delta ${canNavigate ? "clickable" : ""}`}
          onClick={canNavigate ? onNavigate : undefined}
          title={canNavigate ? "Go to flashcard" : undefined}
        >
          {"\u0394"}
        </span>
        <div className="claude-agent-fc-bubble-wrap">
          <div
            className="claude-agent-fc-bubble"
            onClick={() => setShowPrompt(p => !p)}
            title="Click to reveal prompt"
          >
            <MarkdownContent content={fc.question} className="claude-agent-fc-question" />
            <div className="claude-agent-fc-divider" />
            <MarkdownContent content={fc.answer} className="claude-agent-fc-answer" />
          </div>
        </div>
      </div>
      {showPrompt && (
        <div className="claude-agent-fc-raw-prompt">
          <MarkdownContent content={rawContent} className="claude-agent-message-content" />
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, markerMetadata }: { message: ChatMessage; markerMetadata?: { flashcardId?: string; sourceFile?: string; question?: string } }) {
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
      const canNavigate = !!markerMetadata?.sourceFile;
      const navigateToFlashcard = () => {
        if (!canNavigate) return;
        window.dispatchEvent(new CustomEvent("flashcard:navigate", {
          detail: {
            sourceFile: markerMetadata!.sourceFile,
            flashcardId: markerMetadata!.flashcardId,
            question: markerMetadata!.question,
          },
        }));
      };

      return (
        <FlashcardBubble
          fc={fc}
          rawContent={message.content}
          flashcardId={markerMetadata?.flashcardId}
          canNavigate={canNavigate}
          onNavigate={navigateToFlashcard}
        />
      );
    }
  }

  return (
    <div
      className={`claude-agent-message ${message.role} ${message.toolName ? "tool-call" : ""}`}
    >
      {message.images && message.images.length > 0 && (
        <div className="claude-agent-message-images">
          {message.images.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mediaType};base64,${img.data}`}
              className="claude-agent-message-image"
              alt={img.name || "attached image"}
            />
          ))}
        </div>
      )}
      {message.toolName && (
        <div className="claude-agent-tool-label">
          {message.toolName}
        </div>
      )}
      {message.content && (
        <MarkdownContent
          content={message.content}
          className="claude-agent-message-content"
        />
      )}
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

  // Scroll to existing flashcard marker (dedup)
  useEffect(() => {
    if (!pendingScrollFlashcardId) return;

    const elements = document.querySelectorAll<HTMLElement>(
      `[data-flashcard-id="${CSS.escape(pendingScrollFlashcardId)}"]`
    );
    if (elements.length === 0) return; // messages still loading — re-fires on next change

    const target = elements[elements.length - 1];
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("claude-agent-marker-highlight");
    const bubble = target.querySelector(".claude-agent-fc-bubble");
    (bubble ?? target).addEventListener("animationend", () => {
      target.classList.remove("claude-agent-marker-highlight");
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
        const isCompact = !!group.boundary;
        const isCollapsed = isCompact && !expandedGroups.has(groupIndex);

        return (
          <React.Fragment key={groupIndex}>
            {!isCollapsed &&
              group.messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  markerMetadata={message.markerMetadata}
                />
              ))}

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
