import { commandRegistry } from "./registry";
import { newCommand } from "./builtins/new";
import { compactCommand } from "./builtins/compact";
import { doneCommand } from "./builtins/done";
import { renameCommand } from "./builtins/rename";
import { sessionsCommand } from "./builtins/sessions";
import { versionCommand } from "./builtins/version";

export function initializeCommands(): void {
  commandRegistry.register(newCommand);
  commandRegistry.register(compactCommand);
  commandRegistry.register(doneCommand);
  commandRegistry.register(renameCommand);
  commandRegistry.register(sessionsCommand);
  commandRegistry.register(versionCommand);
}

export { commandRegistry } from "./registry";
export { parseInput } from "./parser";
export type {
  SlashCommand,
  CommandContext,
  CommandResult,
  ParseResult,
} from "./types";
