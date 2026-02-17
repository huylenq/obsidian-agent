import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { encodePath } from "./transcript.js";

export function getThreadsPath(workingDirectory, sessionId) {
  return join(homedir(), ".claude", "projects", encodePath(workingDirectory), `${sessionId}.threads.json`);
}

export function loadThreads(threadsPath) {
  if (!existsSync(threadsPath)) return [];
  try {
    return JSON.parse(readFileSync(threadsPath, "utf-8"));
  } catch { return []; }
}

export function appendThread(threadsPath, entry) {
  const threads = loadThreads(threadsPath);
  threads.push(entry);
  writeFileSync(threadsPath, JSON.stringify(threads, null, 2));
}
