import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { App, Platform, setIcon, TFile, TFolder } from "obsidian";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { CommandAutocomplete } from "./CommandAutocomplete";
import { searchVaultItems, FileSearchResult } from "@/utils/fileSearch";
import { parseInput, commandRegistry, SlashCommand } from "@/commands";
import { ImageAttachment } from "@/types";
import { blobToImageAttachment } from "@/utils/imageUtils";

export interface ChatInputHandle {
  insertMention: (path: string) => void;
  triggerAttach: () => void;
}

interface ChatInputProps {
  onSend: (message: string, mentionedFiles: FileSearchResult[], images?: ImageAttachment[]) => void;
  onCommand: (commandName: string, args: string) => void;
  disabled: boolean;
  isStreaming?: boolean;
  onInterrupt?: () => void;
  app: App;
  onRef?: (handle: ChatInputHandle) => void;
}

interface MentionState {
  isActive: boolean;
  startIndex: number;
  query: string;
}

interface CommandState {
  isActive: boolean;
  query: string;
}

/**
 * Extract all @"path" mentions from text
 */
function extractMentionedPaths(text: string): string[] {
  const regex = /@"([^"]+)"/g;
  const paths: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/**
 * Parse current mention being typed (@ followed by non-space chars)
 */
function getCurrentMention(text: string, cursorPos: number): MentionState {
  // Look backwards from cursor for @
  let startIndex = -1;
  for (let i = cursorPos - 1; i >= 0; i--) {
    const char = text[i];
    if (char === " " || char === "\n" || char === "\t" || char === '"') break;
    if (char === "@") {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    return { isActive: false, startIndex: -1, query: "" };
  }

  const query = text.slice(startIndex + 1, cursorPos);
  return { isActive: true, startIndex, query };
}

/**
 * Detect if user is typing a command (/ at start of input)
 */
function getCommandState(text: string): CommandState {
  // Command must start at beginning of input
  if (!text.startsWith("/")) {
    return { isActive: false, query: "" };
  }

  // Check if there's a space (command is complete, now typing args)
  if (text.includes(" ")) {
    return { isActive: false, query: "" };
  }

  // Extract the partial command name (without the /)
  const query = text.slice(1);
  return { isActive: true, query };
}

export function ChatInput({ onSend, onCommand, disabled, isStreaming, onInterrupt, app, onRef }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [mentionState, setMentionState] = useState<MentionState>({
    isActive: false,
    startIndex: -1,
    query: "",
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commandState, setCommandState] = useState<CommandState>({
    isActive: false,
    query: "",
  });
  const [commandSelectedIndex, setCommandSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sendIconCallback = useCallback((el: HTMLSpanElement | null) => {
    if (el) setIcon(el, "corner-down-left");
  }, []);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const searchResults = useMemo(() => {
    if (!mentionState.isActive || !mentionState.query) return [];
    return searchVaultItems(app, mentionState.query, 8);
  }, [app, mentionState.isActive, mentionState.query]);

  const filteredCommands = useMemo(() => {
    if (!commandState.isActive) return [];
    const allCommands = commandRegistry.getAll();
    if (!commandState.query) return allCommands;
    return allCommands.filter(
      (cmd) =>
        cmd.name.startsWith(commandState.query.toLowerCase()) ||
        cmd.aliases?.some((a) => a.startsWith(commandState.query.toLowerCase()))
    );
  }, [commandState.isActive, commandState.query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchResults]);

  useEffect(() => {
    setCommandSelectedIndex(0);
  }, [filteredCommands]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Listen for focus requests (e.g., after model selection)
  useEffect(() => {
    const handleFocus = () => textareaRef.current?.focus();
    window.addEventListener("claude-agent:focus-input", handleFocus);
    return () => window.removeEventListener("claude-agent:focus-input", handleFocus);
  }, []);

  // Expose insertMention function via onRef callback
  const insertMention = useCallback((path: string) => {
    const mention = `@"${path}" `;
    setInput((prev) => {
      const newValue = prev + mention;
      // Focus and move cursor after the mention
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newValue.length, newValue.length);
        }
      });
      return newValue;
    });
  }, []);

  useEffect(() => {
    if (onRef) {
      onRef({ insertMention, triggerAttach: handleAttachClick });
    }
  }, [onRef, insertMention, handleAttachClick]);

  const handleSelect = useCallback(
    (file: FileSearchResult) => {
      if (!textareaRef.current) return;

      const cursorPos = textareaRef.current.selectionStart;
      const before = input.slice(0, mentionState.startIndex);
      const after = input.slice(cursorPos);
      const mention = `@"${file.path}" `;
      const newInput = before + mention + after;

      setInput(newInput);
      setMentionState({ isActive: false, startIndex: -1, query: "" });

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const newPos = before.length + mention.length;
          textareaRef.current.setSelectionRange(newPos, newPos);
          textareaRef.current.focus();
        }
      });
    },
    [input, mentionState.startIndex]
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand) => {
      // Execute the command immediately — no second Enter needed
      onCommand(command.name, "");
      setInput("");
      setMentionState({ isActive: false, startIndex: -1, query: "" });
      setCommandState({ isActive: false, query: "" });
    },
    [onCommand]
  );

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed && images.length === 0) return;

    if (trimmed) {
      const parsed = parseInput(trimmed);

      if (parsed.isCommand) {
        onCommand(parsed.commandName!, parsed.args || "");
        setInput("");
        setImages([]);
        setMentionState({ isActive: false, startIndex: -1, query: "" });
        setCommandState({ isActive: false, query: "" });
        return;
      }
    }

    const mentionedPaths = extractMentionedPaths(trimmed);
    const allItems = app.vault.getAllLoadedFiles();
    const mentionedFiles: FileSearchResult[] = mentionedPaths
      .map((path) => {
        const item = allItems.find((f) => f.path === path);
        if (!item) return null;
        const isFolder = item instanceof TFolder;
        return {
          path: item.path,
          name: item.name,
          extension: isFolder ? "" : (item as TFile).extension,
          type: isFolder ? "folder" : "file",
        } as FileSearchResult;
      })
      .filter((f): f is FileSearchResult => f !== null);

    onSend(trimmed, mentionedFiles, images.length > 0 ? images : undefined);
    setInput("");
    setImages([]);
    setMentionState({ isActive: false, startIndex: -1, query: "" });
    setCommandState({ isActive: false, query: "" });
  }, [input, images, app, onSend, onCommand]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPos = e.target.selectionStart;
      setInput(newValue);
      setMentionState(getCurrentMention(newValue, cursorPos));
      setCommandState(getCommandState(newValue));
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Handle command autocomplete
      if (commandState.isActive && filteredCommands.length > 0) {
        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            setCommandSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
            return;
          case "ArrowUp":
            e.preventDefault();
            setCommandSelectedIndex((i) => Math.max(i - 1, 0));
            return;
          case "Enter":
          case "Tab":
            e.preventDefault();
            handleCommandSelect(filteredCommands[commandSelectedIndex]);
            return;
          case "Escape":
            e.preventDefault();
            setCommandState({ isActive: false, query: "" });
            return;
        }
      }

      // Handle mention autocomplete
      if (mentionState.isActive && searchResults.length > 0) {
        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            setSelectedIndex((i) => Math.min(i + 1, searchResults.length - 1));
            return;
          case "ArrowUp":
            e.preventDefault();
            setSelectedIndex((i) => Math.max(i - 1, 0));
            return;
          case "Enter":
          case "Tab":
            e.preventDefault();
            handleSelect(searchResults[selectedIndex]);
            return;
          case "Escape":
            e.preventDefault();
            setMentionState({ isActive: false, startIndex: -1, query: "" });
            return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && !Platform.isMobile) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [
      commandState.isActive,
      filteredCommands,
      commandSelectedIndex,
      handleCommandSelect,
      mentionState.isActive,
      searchResults,
      selectedIndex,
      handleSelect,
      handleSubmit,
    ]
  );

  // ── Image paste handler ──
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.files;
      if (!items || items.length === 0) return;

      const imageFiles = Array.from(items).filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return;

      e.preventDefault();

      try {
        const attachments = await Promise.all(
          imageFiles.map((f) => blobToImageAttachment(f, f.name))
        );
        setImages((prev) => [...prev, ...attachments]);
      } catch (err) {
        console.error("[ChatInput] Failed to process pasted image:", err);
      }
    },
    []
  );

  // ── Image drop handler ──
  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return;

      e.preventDefault();
      e.stopPropagation();

      try {
        const attachments = await Promise.all(
          imageFiles.map((f) => blobToImageAttachment(f, f.name))
        );
        setImages((prev) => [...prev, ...attachments]);
      } catch (err) {
        console.error("[ChatInput] Failed to process dropped image:", err);
      }
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  // ── OS file picker ──
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      try {
        const attachments = await Promise.all(
          Array.from(files).map((f) => blobToImageAttachment(f, f.name))
        );
        setImages((prev) => [...prev, ...attachments]);
      } catch (err) {
        console.error("[ChatInput] Failed to load image file:", err);
      }

      // Reset so the same file can be re-selected
      e.target.value = "";
    },
    []
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <div className="claude-agent-input-wrapper" onDrop={handleDrop} onDragOver={handleDragOver}>
      {commandState.isActive && filteredCommands.length > 0 && (
        <CommandAutocomplete
          commands={filteredCommands}
          selectedIndex={commandSelectedIndex}
          onSelect={handleCommandSelect}
        />
      )}
      {mentionState.isActive && searchResults.length > 0 && (
        <MentionAutocomplete
          results={searchResults}
          selectedIndex={selectedIndex}
          onSelect={handleSelect}
        />
      )}
      {images.length > 0 && (
        <div className="claude-agent-image-previews">
          {images.map((img, i) => (
            <div key={i} className="claude-agent-image-preview">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name || "attachment"} />
              <button
                className="claude-agent-image-preview-remove"
                onClick={() => removeImage(i)}
                aria-label="Remove image"
              >&times;</button>
            </div>
          ))}
        </div>
      )}
      <div className="claude-agent-input-container">
        <button
          className="claude-agent-attach-button clickable-icon"
          onClick={handleAttachClick}
          aria-label="Attach image"
        >
          <span ref={attachIconCallback} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          style={{ display: "none" }}
          onChange={handleFileInputChange}
        />
        <textarea
          ref={textareaRef}
          className="claude-agent-input"
          placeholder="Ask away..."
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={false}
          rows={1}
        />
        {isStreaming && !input.trim() && images.length === 0 ? (
          <button
            className="claude-agent-interrupt-button clickable-icon"
            onClick={onInterrupt}
            aria-label="Stop"
          >
            &#9632;
          </button>
        ) : (
          <button
            className="claude-agent-send-button clickable-icon"
            onClick={handleSubmit}
            disabled={!input.trim() && images.length === 0}
            aria-label="Send"
          >
            <span ref={sendIconCallback} />
          </button>
        )}
      </div>
    </div>
  );
}
