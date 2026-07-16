import { SlashCommand } from "../types";
import { setSessionsMode } from "@/state/sessionState";
import { AGENT_EVENTS } from "@/events";

export const sessionsCommand: SlashCommand = {
  name: "sessions",
  aliases: ["history"],
  description: "Open the Sessions panel in All mode",

  async execute(context) {
    setSessionsMode("all");
    // Open the sessions view in the sidebar
    await context.plugin.activateSessionsView();
    window.dispatchEvent(new CustomEvent(AGENT_EVENTS.refreshSessions));

    return {
      success: true,
      silent: true,
    };
  },
};
