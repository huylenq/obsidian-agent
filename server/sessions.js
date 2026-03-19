import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { encodePath, extractTextFromEntry } from "./transcript.js";

export function getRegistryPath(workingDirectory) {
  return join(homedir(), ".claude", "projects", encodePath(workingDirectory), "session-registry.json");
}

export function loadRegistry(workingDirectory) {
  const registryPath = getRegistryPath(workingDirectory);
  if (!existsSync(registryPath)) return { version: 1, sessions: [] };
  try {
    return JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch { return { version: 1, sessions: [] }; }
}

export function saveRegistry(workingDirectory, registry) {
  const registryPath = getRegistryPath(workingDirectory);
  const dir = join(registryPath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

export function updateSessionEntry(workingDirectory, sessionId, updates) {
  const registry = loadRegistry(workingDirectory);
  let entry = registry.sessions.find(s => s.id === sessionId);
  if (!entry) {
    entry = {
      id: sessionId,
      title: "",
      status: "in_progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: "haiku",
      messageCount: 0,
      files: [],
    };
    registry.sessions.push(entry);
  }

  if (updates.title !== undefined) entry.title = updates.title;
  if (updates.status !== undefined) entry.status = updates.status;
  if (updates.model !== undefined) entry.model = updates.model;
  if (updates.messageCount !== undefined) entry.messageCount = updates.messageCount;
  if (updates.updatedAt !== undefined) entry.updatedAt = updates.updatedAt;
  if (updates.type !== undefined) entry.type = updates.type;
  if (updates.epoch !== undefined) entry.epoch = updates.epoch;

  // Merge files (deduplicate)
  if (updates.files && updates.files.length > 0) {
    const fileSet = new Set(entry.files);
    for (const f of updates.files) {
      if (f) fileSet.add(f);
    }
    entry.files = [...fileSet];
  }

  saveRegistry(workingDirectory, registry);
  return entry;
}

/** Delete a session: remove from registry and nuke all associated files */
export function deleteSession(workingDirectory, sessionId) {
  const registry = loadRegistry(workingDirectory);
  const idx = registry.sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) throw new Error(`Session ${sessionId} not found in registry`);

  registry.sessions.splice(idx, 1);
  saveRegistry(workingDirectory, registry);

  // Nuke transcript + sidecars
  const projectDir = join(homedir(), ".claude", "projects", encodePath(workingDirectory));
  const files = [
    `${sessionId}.jsonl`,
    `${sessionId}.summaries.json`,
    `${sessionId}.markers.json`,
  ];
  for (const f of files) {
    const p = join(projectDir, f);
    if (existsSync(p)) unlinkSync(p);
  }
}

/** Collect vault-relative file paths from chat request body */
export function collectFilePaths(body) {
  const paths = [];
  if (body.activeFile?.path) paths.push(body.activeFile.path);
  if (body.mentionedFiles) {
    for (const f of body.mentionedFiles) {
      if (f.path) paths.push(f.path);
    }
  }
  if (body.relevantNotes) {
    for (const n of body.relevantNotes) {
      if (n.path) paths.push(n.path);
    }
  }
  return [...new Set(paths)];
}

/** Check if a transcript is a warmup/sidechain session that should be skipped */
export function isWarmupTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return false;
  const content = readFileSync(transcriptPath, "utf-8");
  const firstLine = content.split("\n")[0];
  if (!firstLine) return false;
  try {
    const entry = JSON.parse(firstLine);
    // SDK warmup sessions have isSidechain:true and "Warmup" as first message
    if (entry.isSidechain) return true;
    const text = extractTextFromEntry(entry);
    if (text && /^warmup$/i.test(text.trim())) return true;
  } catch { /* not parseable, skip */ }
  return false;
}

/** Extract first user message title from transcript JSONL */
export function extractTitleFromTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return "";
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user") {
        const text = extractTextFromEntry(entry);
        if (text && !text.startsWith("/") && !/^warmup$/i.test(text.trim())) {
          // Strip markdown, collapse whitespace, truncate to 80 chars
          const clean = text.replace(/[#*_`\[\]]/g, "").replace(/\s+/g, " ").trim();
          return clean.slice(0, 80);
        }
      }
    } catch { /* skip malformed */ }
  }
  return "";
}

/** Extract file paths from system prompts in transcript (for migration) */
export function extractFilePathsFromTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const content = readFileSync(transcriptPath, "utf-8");
  const paths = new Set();
  // Match "currently viewing: **path**" patterns
  const viewingRegex = /currently viewing:\s*\*\*([^*]+)\*\*/gi;
  let match;
  while ((match = viewingRegex.exec(content)) !== null) {
    paths.add(match[1].trim());
  }
  return [...paths];
}

/** Count messages in a transcript */
export function countTranscriptMessages(transcriptPath) {
  if (!existsSync(transcriptPath)) return 0;
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" || entry.type === "assistant") count++;
    } catch { /* skip */ }
  }
  return count;
}

/** Count user-only messages (excluding tool results) — matches history.js user message counting */
export function countUserOnlyMessages(transcriptPath) {
  if (!existsSync(transcriptPath)) return 0;
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" && entry.toolUseResult === undefined) count++;
    } catch { /* skip */ }
  }
  return count;
}

/** Get first and last timestamps from transcript */
export function getTranscriptTimestamps(transcriptPath) {
  if (!existsSync(transcriptPath)) return { first: Date.now(), last: Date.now() };
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  let first = Date.now();
  let last = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        if (entry.timestamp < first) first = entry.timestamp;
        if (entry.timestamp > last) last = entry.timestamp;
      }
    } catch { /* skip */ }
  }
  return { first, last: last || first };
}
