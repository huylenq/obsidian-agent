import { App } from "obsidian";
import type HermesAgentPlugin from "@/main";

export interface CommandContext {
  plugin: HermesAgentPlugin;
  app: App;
  clearMessages: () => void;
}

export interface CommandResult {
  success: boolean;
  message?: string;
  silent?: boolean;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute: (context: CommandContext, args: string) => Promise<CommandResult>;
}

export interface ParseResult {
  isCommand: boolean;
  commandName?: string;
  args?: string;
  rawInput: string;
}
