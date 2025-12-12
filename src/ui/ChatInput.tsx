import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { App } from "obsidian";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { searchVaultFiles, FileSearchResult } from "@/utils/fileSearch";

interface ChatInputProps {
  onSend: (message: string, mentionedFiles: FileSearchResult[]) => void;
  disabled: boolean;
  app: App;
}

interface MentionState {
  isActive: boolean;
  startIndex: number;
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

export function ChatInput({ onSend, disabled, app }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [mentionState, setMentionState] = useState<MentionState>({
    isActive: false,
    startIndex: -1,
    query: "",
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const searchResults = useMemo(() => {
    if (!mentionState.isActive || !mentionState.query) return [];
    return searchVaultFiles(app, mentionState.query, 8);
  }, [app, mentionState.isActive, mentionState.query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchResults]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    textareaRef.current?.focus();
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

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed && !disabled) {
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
    }
  }, [input, disabled, app, onSend]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPos = e.target.selectionStart;
      setInput(newValue);
      setMentionState(getCurrentMention(newValue, cursorPos));
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    [mentionState.isActive, searchResults, selectedIndex, handleSelect, handleSubmit]
  );

  return (
    <div className="claude-agent-input-wrapper">
      {mentionState.isActive && searchResults.length > 0 && (
        <MentionAutocomplete
          results={searchResults}
          selectedIndex={selectedIndex}
          onSelect={handleSelect}
          position={{ top: 4, left: 0 }}
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
        >
          Send
        </button>
      </div>
    </div>
  );
}
