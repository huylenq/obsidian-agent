import { SlashCommand } from "../types";

export const versionCommand: SlashCommand = {
  name: "version",
  aliases: ["v"],
  description: "Show plugin version",

  async execute(context) {
    const version = context.plugin.manifest.version;
    return {
      success: true,
      message: `Hermes Agent v${version}`,
    };
  },
};
