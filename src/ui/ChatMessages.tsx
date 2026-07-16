import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { setIcon } from "obsidian";
import { useAtomValue } from "jotai";
import {
  messagesAtom,
  streamingMessageAtom,
  isLoadingAtom,
  errorAtom,
  chatStore,
} from "@/state/chatState";
import { MarkdownContent } from "./MarkdownContent";
import { ToolGroup } from "./ToolGroup";
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

// Coalesce runs of consecutive tool_block messages into a single virtual
// message whose toolBlocks aggregate the run. The chat stream emits one
// tool_block per tool_use event; visual grouping happens at render time.
function coalesceToolBlocks(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (
      msg.role === "tool_block" &&
      msg.toolBlocks &&
      prev?.role === "tool_block" &&
      prev.toolBlocks
    ) {
      out[out.length - 1] = {
        ...prev,
        toolBlocks: [...prev.toolBlocks, ...msg.toolBlocks],
      };
    } else {
      out.push(msg);
    }
  }
  return out;
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
    <div className="hermes-agent-compact-boundary" onClick={onToggle}>
      <div className="hermes-agent-compact-boundary-line" />
      <div className="hermes-agent-compact-boundary-header">
        <span className={`hermes-agent-compact-chevron ${isCollapsed ? "" : "expanded"}`}>
          &#9656;
        </span>
        <span className="hermes-agent-compact-label">
          {messageCount} messages compacted ({tokenLabel} tokens)
        </span>
      </div>
      {summary && (
        <div className="hermes-agent-compact-summary">{summary}</div>
      )}
      {sdkSummary && (
        <div className="hermes-agent-compact-sdk-summary" onClick={(e) => e.stopPropagation()}>
          <MarkdownContent content={sdkSummary} className="hermes-agent-compact-sdk-summary-content" />
        </div>
      )}
      <div className="hermes-agent-compact-boundary-line" />
    </div>
  );
}

function truncateSelectionPreview(text: string, maxChars = 200, maxLines = 5): string {
  const lines = text.split("\n").slice(0, maxLines);
  let result = lines.join("\n");
  if (text.split("\n").length > maxLines) result += "\n\u2026";
  if (result.length > maxChars) result = result.slice(0, maxChars) + "\u2026";
  return result;
}

const FLASHCARD_PREFIX = "Explain this flashcard";
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
      className="hermes-agent-fc-row"
      data-flashcard-id={flashcardId}
    >
      <div className="hermes-agent-fc-card-row">
        <span
          className={`hermes-agent-fc-delta ${canNavigate ? "clickable" : ""}`}
          onClick={canNavigate ? onNavigate : undefined}
          title={canNavigate ? "Go to flashcard" : undefined}
        >
          {"\u0394"}
        </span>
        <div className="hermes-agent-fc-bubble-wrap">
          <div
            className="hermes-agent-fc-bubble"
            onClick={() => setShowPrompt(p => !p)}
            title="Click to reveal prompt"
          >
            <MarkdownContent content={fc.question} className="hermes-agent-fc-question" />
            <div className="hermes-agent-fc-divider" />
            <MarkdownContent content={fc.answer} className="hermes-agent-fc-answer" />
          </div>
        </div>
      </div>
      {showPrompt && (
        <div className="hermes-agent-fc-raw-prompt">
          <MarkdownContent content={rawContent} className="hermes-agent-message-content" />
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, markerMetadata }: { message: ChatMessage; markerMetadata?: { flashcardId?: string; sourceFile?: string; question?: string } }) {
  if (message.role === "tool_block" && message.toolBlocks) {
    return (
      <div className="hermes-agent-message tool_block">
        <ToolGroup blocks={message.toolBlocks} />
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

  const sel = message.selectionContext;
  const selLabel = sel
    ? `${sel.fileName}${
        sel.startLine !== undefined
          ? sel.startLine === sel.endLine ? ` L${sel.startLine}` : ` L${sel.startLine}-${sel.endLine}`
          : ""
      }`
    : null;
  const selIconRef = useCallback((el: HTMLSpanElement | null) => {
    if (el) setIcon(el, "text-select");
  }, []);

  return (
    <div
      className={`hermes-agent-message ${message.role} ${message.toolName ? "tool-call" : ""}`}
    >
      {message.images && message.images.length > 0 && (
        <div className="hermes-agent-message-images">
          {message.images.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mediaType};base64,${img.data}`}
              className="hermes-agent-message-image"
              alt={img.name || "attached image"}
            />
          ))}
        </div>
      )}
      {sel && (
        <div className="hermes-agent-selection-block">
          <div className="hermes-agent-selection-block-header">
            <span ref={selIconRef} />
            <span>{selLabel}</span>
          </div>
          {sel.text && (
            <div className="hermes-agent-selection-block-text">
              {truncateSelectionPreview(sel.text)}
            </div>
          )}
        </div>
      )}
      {message.toolName && (
        <div className="hermes-agent-tool-label">
          {message.toolName}
        </div>
      )}
      {message.content && (
        <MarkdownContent
          content={message.content}
          className="hermes-agent-message-content"
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
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const groups = useMemo(() => groupMessagesByBoundary(messages), [messages]);

  // Track whether user is scrolled near the bottom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 80;
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

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

  // Auto-scroll to bottom when messages change, only if user is near bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
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
    target.classList.add("hermes-agent-marker-highlight");
    const bubble = target.querySelector(".hermes-agent-fc-bubble");
    (bubble ?? target).addEventListener("animationend", () => {
      target.classList.remove("hermes-agent-marker-highlight");
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
      <div className="hermes-agent-empty-state">
        <h3>Chat with your vault</h3>
        <p>Ask questions about your notes and Hermes will search and answer based on your knowledge base.</p>
      </div>
    );
  }

  return (
    <div className="hermes-agent-messages" ref={containerRef}>
      {groups.map((group, groupIndex) => {
        const isCompact = !!group.boundary;
        const isCollapsed = isCompact && !expandedGroups.has(groupIndex);

        return (
          <React.Fragment key={groupIndex}>
            {!isCollapsed &&
              coalesceToolBlocks(group.messages).map((message) => (
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
        <div className="hermes-agent-message assistant">
          <MarkdownContent
            content={streamingMessage}
            className="hermes-agent-message-content"
          />
        </div>
      )}

      {/* Loading indicator */}
      {isLoading && !streamingMessage && (
        <div className="hermes-agent-loading">
          <div className="hermes-agent-loading-dots">
            <div className="hermes-agent-loading-dot"></div>
            <div className="hermes-agent-loading-dot"></div>
            <div className="hermes-agent-loading-dot"></div>
          </div>
          <span>Lulu is thinking...</span>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="hermes-agent-message error">
          <strong>Error:</strong> {error}
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
