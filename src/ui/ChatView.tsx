import React, { useCallback, useState, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { App, ItemView, WorkspaceLeaf, MarkdownView, setIcon } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { ActiveFileContext, ChatViewLocation, ClaudeModel, SelectionContext, MarkerMetadata, RankedNote } from "@/types";

/** Build the transcript file path for a session and open it with the OS default app. */
function openTranscriptFile(vaultPath: string, sessionId: string): void {
  try {
    const home = require("os").homedir();
    const { join } = require("path");
    const encoded = vaultPath.replace(/[\/\s~]/g, "-");
    const filePath = join(home, ".claude", "projects", encoded, `${sessionId}.jsonl`);
    // Electron's shell module is available in renderer process
    const { shell } = require("electron");
    shell.openPath(filePath);
  } catch {
    // Fallback: copy session ID to clipboard
    navigator.clipboard.writeText(sessionId);
  }
}
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
  isStreamingAtom,
  setStreaming,
  chatStore,
  generateMessageId,
  clearMessages,
  messagesAtom,
  modelAtom,
  updateToolMessage,
} from "@/state/chatState";
import { addToQueue, updateQueueStatus, clearQueue } from "@/state/messageQueueState";
import {
  relevantNotesAtom,
  includeRelevantNotesAtom,
  setIncludeRelevantNotes,
} from "@/state/relevantNotesState";
import { connectionStatusAtom, connectionErrorAtom } from "@/state/connectionState";
import { ChatMessage, CompactMetadata, ToolBlock, SessionType, SessionEntry } from "@/types";
import type ClaudeAgentPlugin from "@/main";
import { initializeCommands, commandRegistry, CommandContext } from "@/commands";

export const CHAT_VIEW_TYPE = "claude-agent-chat";

/** Map raw history messages to ChatMessage[]. */
function mapHistoryMessages(raw: Array<Record<string, unknown>>): ChatMessage[] {
  return raw.map((msg) => ({
    id: generateMessageId(),
    role: msg.role as ChatMessage["role"],
    content: (msg.content as string) || "",
    timestamp: (msg.timestamp as number) || Date.now(),
    ...((msg.compactMetadata as CompactMetadata) && { compactMetadata: msg.compactMetadata as CompactMetadata }),
    ...((msg.toolBlocks as ToolBlock[]) && { toolBlocks: msg.toolBlocks as ToolBlock[] }),
    ...((msg.markerMetadata as MarkerMetadata) && { markerMetadata: msg.markerMetadata as MarkerMetadata }),
  }));
}

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

function formatEpochDate(epoch: string): string {
  // epoch is "YYYY-MM-DD" — parse as local date
  const [y, m, d] = epoch.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Simple fuzzy match: characters of query appear in order within text (case-insensitive) */
function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  let j = 0;
  for (let i = 0; i < lower.length && j < query.length; i++) {
    if (lower[i] === query[j]) j++;
  }
  return j === query.length;
}

function ChatContainer({ plugin, app }: ChatContainerProps) {
  const isLoading = useAtomValue(isLoadingAtom, { store: chatStore });
  const isStreaming = useAtomValue(isStreamingAtom, { store: chatStore });
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
  const [sessionType, setSessionType] = useState<string | null>(null);
  const [sessionEpoch, setSessionEpoch] = useState<string | null>(null);
  const [pendingScrollFlashcardId, setPendingScrollFlashcardId] = useState<string | null>(null);
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const [sessionDropdown, setSessionDropdown] = useState<SessionEntry[] | null>(null);
  const [dropdownQuery, setDropdownQuery] = useState("");
  const [dropdownIndex, setDropdownIndex] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownInputRef = useRef<HTMLInputElement>(null);
  const viewLocationIconRef = useRef<HTMLSpanElement>(null);
  const [viewLocation, setViewLocation] = useState<ChatViewLocation>(
    plugin.settings.chatViewLocation
  );

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
      setIcon(checkIconRef.current, includeRelevantNotes ? "circle-plus" : "circle");
    }
    if (viewLocationIconRef.current) {
      // sidebar = panel-right-open, tab = panel-right-close (toggles to opposite)
      setIcon(viewLocationIconRef.current, viewLocation === "sidebar" ? "panel-right-open" : "panel-right-close");
    }
  }, [includeRelevantNotes, viewLocation]);

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
          const chatMessages = mapHistoryMessages(historyMessages);
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
    setSessionType(null);
    setSessionEpoch(null);
    // Notify SessionsView
    window.dispatchEvent(new CustomEvent("claude-agent:session-changed", { detail: { sessionId: null } }));
    window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));
  }, [plugin.claudeClient]);

  // Initialize slash commands
  useEffect(() => {
    initializeCommands();
  }, []);

  // Listen for "open file" events (e.g. from markdown links in chat)
  useEffect(() => {
    const handleOpenFile = (event: CustomEvent<{ path: string }>) => {
      app.workspace.openLinkText(event.detail.path, "", false);
    };
    window.addEventListener("claude-agent:open-file", handleOpenFile as EventListener);
    return () => window.removeEventListener("claude-agent:open-file", handleOpenFile as EventListener);
  }, [app]);

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
          chatStore.set(messagesAtom, mapHistoryMessages(historyMessages));
        }
      } catch (error) {
        console.warn("[ChatView] Failed to load session history:", error);
      }
    };

    window.addEventListener("claude-agent:switch-session", handleSwitchSession as EventListener);
    return () => window.removeEventListener("claude-agent:switch-session", handleSwitchSession as EventListener);
  }, [plugin.claudeClient]);

  // Listen for "scroll to flashcard" events (dedup — card already explained)
  useEffect(() => {
    const handleScrollToFlashcard = (event: CustomEvent<{ flashcardId: string }>) => {
      setPendingScrollFlashcardId(event.detail.flashcardId);
    };
    window.addEventListener("claude-agent:scroll-to-flashcard", handleScrollToFlashcard as EventListener);
    return () => window.removeEventListener("claude-agent:scroll-to-flashcard", handleScrollToFlashcard as EventListener);
  }, []);

  // Resolve session title + type from registry when sessionId changes
  useEffect(() => {
    const resolve = async () => {
      if (plugin.initializationPromise) {
        await plugin.initializationPromise;
      }

      // Re-read sessionId — initial state may have been null before client was ready
      const resolvedId = sessionId || plugin.claudeClient?.getSessionId() || null;
      if (resolvedId && !sessionId) {
        setSessionId(resolvedId);
      }

      if (!resolvedId || !plugin.claudeClient) {
        setSessionTitle(null);
        setSessionType(null);
        setSessionEpoch(null);
        return;
      }

      const sessions = await plugin.claudeClient.fetchSessions({ status: "all" });
      const entry = sessions.find(s => s.id === resolvedId);
      setSessionTitle(entry?.title || null);
      setSessionType(entry?.type || null);
      setSessionEpoch(entry?.epoch || null);
    };
    resolve();
  }, [sessionId, plugin.claudeClient]);

  const handleMarkDone = useCallback(async () => {
    if (!plugin.claudeClient || !sessionId) return;
    await plugin.claudeClient.updateSession(sessionId, { status: "done" });
    plugin.claudeClient.clearSession();
    clearMessages();
    setSessionId(null);
    setSessionTitle(null);
    setSessionType(null);
    setSessionEpoch(null);
    window.dispatchEvent(new CustomEvent("claude-agent:session-changed", { detail: { sessionId: null } }));
    window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));
  }, [plugin.claudeClient, sessionId]);

  const handleInterrupt = useCallback(async () => {
    const success = await plugin.claudeClient?.interrupt();
    if (success) {
      setStreaming(false);
      setLoading(false);
      setError(null);
      clearQueue();
    }
  }, [plugin]);

  const handleSend = useCallback(
    async (
      message: string,
      mentionedFiles: FileSearchResult[],
      flashcardMeta?: { cardId: string; sourceFile: string; question: string },
      sessionMeta?: { type: SessionType; epoch: string },
      overrideRelevantNotes?: RankedNote[],
    ) => {
      // Flashcard explains use the deeplink's sourceFile, not whatever Obsidian has focused
      const fileContext = flashcardMeta
        ? { path: flashcardMeta.sourceFile, name: flashcardMeta.sourceFile.split("/").pop() || "", extension: "md" }
        : isContextCleared ? undefined : activeFile;
      const selectionContext = selection;

      // If query is active, inject into it instead of starting a new one.
      // Note: isStreaming may be false (turn finished) but queryId still alive.
      if (plugin.claudeClient?.isQueryActive()) {
        // Show user message immediately
        addMessage({
          id: generateMessageId(),
          role: "user",
          content: message,
          timestamp: Date.now(),
        });

        // Inject into active query — re-show stop button
        setStreaming(true);
        setLoading(true);
        const queueId = addToQueue(message);
        const success = await plugin.claudeClient.injectMessage(message);
        updateQueueStatus(queueId, success ? "injected" : "failed");
        return;
      }

      // Set session type eagerly for immediate header display
      if (sessionMeta?.type) {
        setSessionType(sessionMeta.type);
      }

      if (!message.startsWith("/")) {
        addMessage({
          id: generateMessageId(),
          role: "user",
          content: message,
          timestamp: Date.now(),
          ...(flashcardMeta && {
            markerMetadata: {
              markerId: crypto.randomUUID(),
              flashcardId: flashcardMeta.cardId,
              sourceFile: flashcardMeta.sourceFile,
              question: flashcardMeta.question,
            },
          }),
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

        setStreaming(true);

        const highMatchNotes = overrideRelevantNotes
          ? overrideRelevantNotes
          : includeRelevantNotes
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

        for await (const chunk of plugin.claudeClient.chat(message, fileContext, mentionedFiles, selectionContext, highMatchNotes, flashcardMeta, sessionMeta)) {
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

            case "query_ready":
              // queryId captured by client internally, nothing to render
              break;

            case "result":
              // Turn complete — flush any accumulated text and clear streaming state.
              // In streaming-input mode, this fires after each turn while the SSE
              // connection stays open. "done" only fires when the query truly ends.
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
              setStreaming(false);
              setLoading(false);
              break;

            case "error":
              setError(chunk.content || "Unknown error (no details from server)");
              break;

            case "interrupted":
              // User-initiated interrupt — flush partial text and clean up silently
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
              setStreaming(false);
              setLoading(false);
              setError(null);
              break;

            case "done":
              // Final cleanup — query fully closed (iterable exhausted).
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
              setStreaming(false);
              setLoading(false);
              break;
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        setError(errorMessage);
        console.error("Chat error:", error);
      } finally {
        setStreaming(false);
        setLoading(false);
        // Notify SessionsView to refresh (new session may have been created)
        window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));
        window.dispatchEvent(new CustomEvent("claude-agent:session-changed", { detail: { sessionId: plugin.claudeClient?.getSessionId() ?? null } }));
      }
    },
    [plugin, activeFile, isContextCleared, selection, includeRelevantNotes, relevantNotes, isStreaming]
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
        if (commandName === "new" || commandName === "clear" || commandName === "reset" || commandName === "done") {
          setSessionId(null);
          setSessionTitle(null);
          setSessionType(null);
          setSessionEpoch(null);
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
    const handleSendMessage = (event: CustomEvent<{
      message: string;
      flashcardMeta?: { cardId: string; sourceFile: string; question: string };
      sessionMeta?: { type: "flashcard_study"; epoch: string };
      relevantNotes?: RankedNote[];
    }>) => {
      const { message, flashcardMeta, sessionMeta, relevantNotes: eventNotes } = event.detail;
      if (message) {
        handleSend(message, [], flashcardMeta, sessionMeta, eventNotes);
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

  const handleViewLocationToggle = useCallback(() => {
    const newLocation: ChatViewLocation = viewLocation === "sidebar" ? "tab" : "sidebar";
    setViewLocation(newLocation);
    plugin.settings.chatViewLocation = newLocation;
    plugin.saveSettings();
    // Dispatch event to relocate the view
    window.dispatchEvent(new CustomEvent("claude-agent:relocate-view", {
      detail: { location: newLocation },
    }));
  }, [plugin, viewLocation]);

  // Session dropdown: fetch active sessions, prioritize file-relevant
  const handleSessionDropdownToggle = useCallback(async () => {
    if (sessionDropdown) {
      setSessionDropdown(null);
      setDropdownQuery("");
      return;
    }
    if (!plugin.claudeClient) return;
    const sessions = await plugin.claudeClient.fetchSessions({ status: "in_progress" });
    const currentFilePath = activeFile?.path;
    // Sort: file-relevant first, then by updatedAt desc
    const sorted = sessions.sort((a, b) => {
      const aRelevant = currentFilePath && a.files.includes(currentFilePath) ? 1 : 0;
      const bRelevant = currentFilePath && b.files.includes(currentFilePath) ? 1 : 0;
      if (aRelevant !== bRelevant) return bRelevant - aRelevant;
      return b.updatedAt - a.updatedAt;
    });
    setDropdownQuery("");
    setDropdownIndex(-1);
    setSessionDropdown(sorted);
    // Auto-focus input after render
    requestAnimationFrame(() => dropdownInputRef.current?.focus());
  }, [sessionDropdown, plugin.claudeClient, activeFile]);

  const handleSessionSelect = useCallback((targetId: string) => {
    setSessionDropdown(null);
    setDropdownQuery("");
    setDropdownIndex(-1);
    window.dispatchEvent(new CustomEvent("claude-agent:switch-session", { detail: { sessionId: targetId } }));
  }, []);

  const filteredDropdown = sessionDropdown?.filter(
    (s) => !dropdownQuery || fuzzyMatch(s.title || s.id, dropdownQuery)
  ) ?? null;

  // Reset index when query changes
  useEffect(() => {
    setDropdownIndex(-1);
  }, [dropdownQuery]);

  // Close dropdown on outside click; arrow/enter/escape handled on input
  useEffect(() => {
    if (!sessionDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setSessionDropdown(null);
        setDropdownQuery("");
        setDropdownIndex(-1);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [sessionDropdown]);

  // Listen for command to open session switcher (Alt+L)
  useEffect(() => {
    const handleOpenSwitcher = () => handleSessionDropdownToggle();
    window.addEventListener("claude-agent:open-session-switcher", handleOpenSwitcher);
    return () => window.removeEventListener("claude-agent:open-session-switcher", handleOpenSwitcher);
  }, [handleSessionDropdownToggle]);

  const showFileChip = activeFile && !isContextCleared;
  const showSelectionChip = selection !== undefined;

  const isFlashcardSession = sessionType === "flashcard_study";

  return (
    <div className="claude-agent-container">
      <div className={`claude-agent-session-header ${isFlashcardSession ? "flashcard-study" : ""}`} ref={dropdownRef}>
        {isFlashcardSession ? (
          <>
            <span className="claude-agent-session-header-icon">&#128218;</span>
            <span className="claude-agent-session-header-title" onClick={handleSessionDropdownToggle}>
              Flashcard Study{sessionEpoch && ` · ${formatEpochDate(sessionEpoch)}`}
            </span>
          </>
        ) : (
          <span className="claude-agent-session-header-title" onClick={handleSessionDropdownToggle}>
            {sessionTitle || "New Chat"}
          </span>
        )}
        {sessionId && (
          <span
            className={`claude-agent-session-id ${copiedSessionId ? "copied" : ""}`}
            onClick={(e) => {
              if (e.metaKey) {
                const vaultPath = (app.vault.adapter as any).basePath;
                if (vaultPath) openTranscriptFile(vaultPath, sessionId);
              } else {
                navigator.clipboard.writeText(sessionId);
                setCopiedSessionId(true);
                setTimeout(() => setCopiedSessionId(false), 1500);
              }
            }}
            title="Click to copy · ⌘+click to open transcript"
          >
            {copiedSessionId ? "copied!" : sessionId.slice(0, 8)}
          </span>
        )}
        <button
          className="claude-agent-new-chat-button clickable-icon"
          onClick={handleNewChat}
          disabled={isLoading}
          title="New chat"
        >+</button>
        {sessionId && (
          <button
            className="claude-agent-done-button clickable-icon"
            onClick={handleMarkDone}
            disabled={isLoading}
            title="Mark done"
          >&#10003;</button>
        )}
        <span
          className="claude-agent-view-location-toggle"
          onClick={handleViewLocationToggle}
          title={viewLocation === "sidebar" ? "Move to center tab" : "Move to sidebar"}
        >
          <span ref={viewLocationIconRef} className="claude-agent-view-location-icon" />
        </span>
        {sessionDropdown && (
          <div className="claude-agent-session-dropdown">
            <input
              ref={dropdownInputRef}
              className="claude-agent-session-dropdown-search"
              type="text"
              placeholder="Search sessions…"
              value={dropdownQuery}
              onChange={(e) => setDropdownQuery(e.target.value)}
              onKeyDown={(e) => {
                const items = filteredDropdown ?? [];
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setDropdownIndex((i) => Math.min(i + 1, items.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setDropdownIndex((i) => Math.max(i - 1, -1));
                } else if (e.key === "Enter" && dropdownIndex >= 0 && dropdownIndex < items.length) {
                  e.preventDefault();
                  handleSessionSelect(items[dropdownIndex].id);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setSessionDropdown(null);
                  setDropdownQuery("");
                  setDropdownIndex(-1);
                }
              }}
            />
            {filteredDropdown && filteredDropdown.length === 0 ? (
              <div className="claude-agent-session-dropdown-empty">
                {dropdownQuery ? "No matches" : "No active sessions"}
              </div>
            ) : filteredDropdown?.map((s, i) => (
              <div
                key={s.id}
                className={`claude-agent-session-dropdown-item ${s.id === sessionId ? "active" : ""} ${i === dropdownIndex ? "highlighted" : ""}`}
                onClick={() => handleSessionSelect(s.id)}
              >
                <span className="claude-agent-session-dropdown-title">{s.title || s.id.slice(0, 12)}</span>
                <span className="claude-agent-session-dropdown-meta">{s.model}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <ChatMessages
        pendingScrollFlashcardId={pendingScrollFlashcardId}
        onScrollComplete={() => setPendingScrollFlashcardId(null)}
      />
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
          disabled={false}
          isStreaming={isStreaming}
          onInterrupt={handleInterrupt}
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
            Related
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

    // Add class to indicate if this view is in the main workspace (not sidebar)
    // Used for mobile-specific styling (bottom padding when keyboard is hidden)
    this.updateMainLeafClass();

    this.root = createRoot(container);
    this.root.render(<ChatContainer plugin={this.plugin} app={this.plugin.app} />);
  }

  /**
   * Check if this leaf is in the root workspace (main area) vs sidebar.
   * Adds/removes 'is-main-leaf' class on containerEl accordingly.
   */
  private updateMainLeafClass(): void {
    const isMainLeaf = this.leaf.getRoot() === this.plugin.app.workspace.rootSplit;
    this.containerEl.toggleClass("is-main-leaf", isMainLeaf);
  }

  async onClose(): Promise<void> {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
