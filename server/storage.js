import { homedir } from "os";
import { join } from "path";

export function encodePath(workingDirectory) {
  return workingDirectory ? workingDirectory.replace(/[\/\s~]/g, "-") : "";
}

export function getProjectDir(workingDirectory) {
  return join(
    process.env.HERMES_OBSIDIAN_AGENT_HOME
      || join(homedir(), ".hermes", "obsidian-agent"),
    "projects",
    encodePath(workingDirectory),
  );
}
