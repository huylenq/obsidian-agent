import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { App, setIcon } from "obsidian";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { CommandAutocomplete } from "./CommandAutocomplete";
import { searchVaultFiles, FileSearchResult } from "@/utils/fileSearch";
import { parseInput, commandRegistry, SlashCommand } from "@/commands";

interface ChatInputProps {
  onSend: (message: string, mentionedFiles: FileSearchResult[]) => void;
  onCommand: (commandName: string, args: string) => void;
  disabled: boolean;
  app: App;
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

export function ChatInput({ onSend, onCommand, disabled, app }: ChatInputProps) {
  const [input, setInput] = useState("");
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
  const sendIconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (sendIconRef.current) {
      setIcon(sendIconRef.current, "corner-down-left");
    }
  }, []);

  const searchResults = useMemo(() => {
    if (!mentionState.isActive || !mentionState.query) return [];
    return searchVaultFiles(app, mentionState.query, 8);
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
      const newInput = `/${command.name} `;
      setInput(newInput);
      setCommandState({ isActive: false, query: "" });

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(newInput.length, newInput.length);
          textareaRef.current.focus();
        }
      });
    },
    []
  );

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;

    const parsed = parseInput(trimmed);

    if (parsed.isCommand) {
      onCommand(parsed.commandName!, parsed.args || "");
      setInput("");
      setMentionState({ isActive: false, startIndex: -1, query: "" });
      setCommandState({ isActive: false, query: "" });
      return;
    }

    const mentionedPaths = extractMentionedPaths(trimmed);
    const files = app.vault.getFiles();
    const mentionedFiles: FileSearchResult[] = mentionedPaths
      .map((path) => {
        const file = files.find((f) => f.path === path);
        if (!file) return null;
        return { path: file.path, name: file.name, extension: file.extension };
      })
      .filter((f): f is FileSearchResult => f !== null);

    onSend(trimmed, mentionedFiles);
    setInput("");
    setMentionState({ isActive: false, startIndex: -1, query: "" });
    setCommandState({ isActive: false, query: "" });
  }, [input, disabled, app, onSend, onCommand]);

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

      if (e.key === "Enter" && !e.shiftKey) {
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

  return (
    <div className="claude-agent-input-wrapper">
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
      <div className="claude-agent-input-container">
        <textarea
          ref={textareaRef}
          className="claude-agent-input"
          placeholder="Ask about your vault... Use @ to mention files"
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
        />
        <button
          className="claude-agent-send-button"
          onClick={handleSubmit}
          disabled={disabled || !input.trim()}
          aria-label="Send"
        >
          <span ref={sendIconRef} />
        </button>
      </div>
    </div>
  );
}
