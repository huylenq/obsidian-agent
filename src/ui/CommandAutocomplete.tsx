import React, { useEffect, useRef } from "react";
import { setIcon } from "obsidian";
import { SlashCommand } from "@/commands";

interface CommandAutocompleteProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function CommandAutocomplete({
  commands,
  selectedIndex,
  onSelect,
}: CommandAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement;
      selected?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div className="hermes-agent-mention-autocomplete" ref={listRef}>
      {commands.map((command, index) => (
        <CommandItem
          key={command.name}
          command={command}
          isSelected={index === selectedIndex}
          onClick={() => onSelect(command)}
        />
      ))}
    </div>
  );
}

interface CommandItemProps {
  command: SlashCommand;
  isSelected: boolean;
  onClick: () => void;
}

function CommandItem({ command, isSelected, onClick }: CommandItemProps) {
  const iconRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, "terminal");
    }
  }, []);

  return (
    <div
      className={`hermes-agent-mention-item ${isSelected ? "selected" : ""}`}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span ref={iconRef} className="hermes-agent-mention-icon" />
      <div className="hermes-agent-mention-text">
        <span className="hermes-agent-mention-name">/{command.name}</span>
        <span className="hermes-agent-mention-path">{command.description}</span>
      </div>
    </div>
  );
}
