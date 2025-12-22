import { commandRegistry } from "./registry";
import { clearCommand } from "./builtins/clear";

export function initializeCommands(): void {
  commandRegistry.register(clearCommand);
}

export { commandRegistry } from "./registry";
export { parseInput } from "./parser";
export type {
  SlashCommand,
  CommandContext,
  CommandResult,
  ParseResult,
} from "./types";
