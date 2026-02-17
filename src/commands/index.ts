import { commandRegistry } from "./registry";
import { newCommand } from "./builtins/new";
import { compactCommand } from "./builtins/compact";
import { doneCommand } from "./builtins/done";
import { sessionsCommand } from "./builtins/sessions";

export function initializeCommands(): void {
  commandRegistry.register(newCommand);
  commandRegistry.register(compactCommand);
  commandRegistry.register(doneCommand);
  commandRegistry.register(sessionsCommand);
}

export { commandRegistry } from "./registry";
export { parseInput } from "./parser";
export type {
  SlashCommand,
  CommandContext,
  CommandResult,
  ParseResult,
} from "./types";
