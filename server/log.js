import { appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const LOG_FILE = process.env.HERMES_AGENT_LOG_FILE
  || join(homedir(), ".hermes-agent-bridge.log");

// Initialize log file on import
writeFileSync(LOG_FILE, `\n=== Server started at ${new Date().toISOString()} ===\n`);

export function log(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}\n`;
  appendFileSync(LOG_FILE, message);
  console.log(...args);
}

export function logError(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ERROR: ${args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}\n`;
  appendFileSync(LOG_FILE, message);
  console.error(...args);
}
