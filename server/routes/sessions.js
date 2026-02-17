import { Router } from "express";
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log, logError } from "../log.js";
import { encodePath } from "../transcript.js";
import {
  loadRegistry,
  saveRegistry,
  updateSessionEntry,
  isWarmupTranscript,
  extractTitleFromTranscript,
  extractFilePathsFromTranscript,
  countTranscriptMessages,
  getTranscriptTimestamps,
} from "../sessions.js";
import { getThreadsPath, loadThreads } from "../threads.js";

const router = Router();

/**
 * List sessions from registry
 * Query params: status (optional: "in_progress"|"done"), file (optional: vault-relative path)
 */
router.get("/sessions", (req, res) => {
  const { status, file, type, epoch } = req.query;
  const vaultPath = req.vaultPath;

  try {
    const registry = loadRegistry(vaultPath);
    let sessions = registry.sessions;

    if (status && status !== "all") {
      sessions = sessions.filter(s => s.status === status);
    }

    if (file) {
      sessions = sessions.filter(s => s.files.includes(file));
    }

    if (type) {
      sessions = sessions.filter(s => s.type === type);
    }

    if (epoch) {
      sessions = sessions.filter(s => s.epoch === epoch);
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    res.json({ sessions });
  } catch (error) {
    logError("[Proxy] Error listing sessions:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * List threads for a session
 */
router.get("/sessions/:sessionId/threads", (req, res) => {
  const { sessionId } = req.params;
  const vaultPath = req.vaultPath;

  try {
    const threadsPath = getThreadsPath(vaultPath, sessionId);
    const threads = loadThreads(threadsPath);
    res.json({ threads });
  } catch (error) {
    logError("[Proxy] Error loading threads:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a session entry (status, title)
 */
router.patch("/sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const { status, title } = req.body;
  const vaultPath = req.vaultPath;

  try {
    const updates = { updatedAt: Date.now() };
    if (status !== undefined) updates.status = status;
    if (title !== undefined) updates.title = title;

    const entry = updateSessionEntry(vaultPath, sessionId, updates);
    res.json({ session: entry });
  } catch (error) {
    logError("[Proxy] Error updating session:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Migrate: scan all JSONL files to populate registry
 */
router.post("/sessions/migrate", (req, res) => {
  const vaultPath = req.vaultPath;

  try {
    const projectDir = join(homedir(), ".claude", "projects", encodePath(vaultPath));
    if (!existsSync(projectDir)) {
      return res.json({ migrated: 0 });
    }

    const registry = loadRegistry(vaultPath);
    const existingIds = new Set(registry.sessions.map(s => s.id));

    const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
    let migrated = 0;

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      // Skip summaries sidecars
      if (sessionId.endsWith(".summaries")) continue;
      // Skip already registered
      if (existingIds.has(sessionId)) continue;

      const transcriptPath = join(projectDir, file);

      // Skip empty files
      try {
        const stat = statSync(transcriptPath);
        if (stat.size === 0) continue;
      } catch { continue; }

      // Skip warmup/sidechain sessions
      if (isWarmupTranscript(transcriptPath)) continue;

      const title = extractTitleFromTranscript(transcriptPath);
      if (!title) continue; // Skip sessions with no user messages

      const messageCount = countTranscriptMessages(transcriptPath);
      const { first, last } = getTranscriptTimestamps(transcriptPath);
      const filePaths = extractFilePathsFromTranscript(transcriptPath);

      registry.sessions.push({
        id: sessionId,
        title,
        status: "done", // Assume migrated sessions are done
        createdAt: first,
        updatedAt: last,
        model: "haiku", // Default; we can't reliably determine from transcript
        messageCount,
        files: filePaths,
      });
      migrated++;
    }

    saveRegistry(vaultPath, registry);
    log(`[Proxy] Migration complete: ${migrated} sessions migrated`);
    res.json({ migrated });
  } catch (error) {
    logError("[Proxy] Migration error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
