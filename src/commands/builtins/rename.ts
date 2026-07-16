import { SlashCommand } from "../types";
import { AGENT_EVENTS } from "@/events";

export const renameCommand: SlashCommand = {
  name: "rename",
  description: "Rename the current session",

  async execute(context, args) {
    const newTitle = args.trim();
    if (!newTitle) return { success: false, message: "Usage: /rename <title>" };

    const client = context.plugin.hermesClient;
    const sessionId = client?.getSessionId();
    if (!sessionId || !client) return { success: false, message: "No active session to rename." };

    const updated = await client.updateSession(sessionId, { title: newTitle });
    if (!updated) return { success: false, message: "Failed to rename session." };

    window.dispatchEvent(new CustomEvent(AGENT_EVENTS.refreshSessions));

    return { success: true, message: `Renamed to: ${updated.title}` };
  },
};
