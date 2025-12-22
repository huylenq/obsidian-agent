import { SlashCommand } from "../types";

export const clearCommand: SlashCommand = {
  name: "clear",
  aliases: ["new", "reset"],
  description: "Start a new chat session (clears history and session)",

  async execute(context) {
    context.plugin.claudeClient?.clearSession();
    context.clearMessages();

    return {
      success: true,
      silent: true,
    };
  },
};
