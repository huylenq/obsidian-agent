import { SlashCommand } from "../types";

export const doneCommand: SlashCommand = {
  name: "done",
  description: "Mark current session as done and start a new chat",

  async execute(context) {
    const client = context.plugin.hermesClient;
    const sessionId = client?.getSessionId();

    if (sessionId && client) {
      await client.updateSession(sessionId, { status: "done" });
    }

    client?.clearSession();
    context.clearMessages();

    return {
      success: true,
      silent: true,
    };
  },
};
