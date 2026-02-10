import { commandRegistry } from "./registry";
import { clearCommand } from "./builtins/clear";
import { compactCommand } from "./builtins/compact";

export function initializeCommands(): void {
  commandRegistry.register(clearCommand);
  commandRegistry.register(compactCommand);
}

export { commandRegistry } from "./registry";
export { parseInput } from "./parser";
export type {
  SlashCommand,
  CommandContext,
  CommandResult,
  ParseResult,
} from "./types";
