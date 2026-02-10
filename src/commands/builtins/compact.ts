import { SlashCommand } from "../types";

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Compact conversation context (summarizes history to save tokens)",

  async execute() {
    // Execution handled by ChatView — routes through the chat send pipeline
    // This definition exists for autocomplete and command discovery
    return { success: true, silent: true };
  },
};
