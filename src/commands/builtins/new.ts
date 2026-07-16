import { SlashCommand } from "../types";

export const newCommand: SlashCommand = {
  name: "new",
  aliases: ["clear", "reset"],
  description: "Start a new chat session",

  async execute(context) {
    context.plugin.hermesClient?.clearSession();
    context.clearMessages();

    return {
      success: true,
      silent: true,
    };
  },
};
