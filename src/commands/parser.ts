import { ParseResult } from "./types";

/**
 * Parse input to detect slash commands.
 * Commands must start with / followed by alphanumeric characters.
 */
export function parseInput(input: string): ParseResult {
  const trimmed = input.trim();

  if (!trimmed.startsWith("/")) {
    return { isCommand: false, rawInput: input };
  }

  // Match: /commandName [optional args]
  const match = trimmed.match(/^\/(\w+)(?:\s+(.*))?$/);

  if (!match) {
    // Invalid command format (e.g., just "/" or "/123abc"), treat as regular text
    return { isCommand: false, rawInput: input };
  }

  return {
    isCommand: true,
    commandName: match[1].toLowerCase(),
    args: match[2]?.trim() || "",
    rawInput: input,
  };
}
