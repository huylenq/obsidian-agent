import { SlashCommand } from "../types";
import { setSessionsMode } from "@/state/sessionState";

export const sessionsCommand: SlashCommand = {
  name: "sessions",
  aliases: ["history"],
  description: "Open the Sessions panel in All mode",

  async execute(context) {
    setSessionsMode("all");
    // Open the sessions view in the sidebar
    await context.plugin.activateSessionsView();
    window.dispatchEvent(new CustomEvent("claude-agent:refresh-sessions"));

    return {
      success: true,
      silent: true,
    };
  },
};
