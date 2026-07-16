import { Router } from "express";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { log, logError } from "../log.js";
import { getProjectDir } from "../storage.js";
import {
  loadRegistry,
  saveRegistry,
  updateSessionEntry,
  deleteSession,
  isWarmupTranscript,
  extractTitleFromTranscript,
  extractFilePathsFromTranscript,
  countTranscriptMessages,
  getTranscriptTimestamps,
} from "../sessions.js";
import { getMarkersPath, loadMarkers } from "../markers.js";
import { loadTouched } from "../touchedNotes.js";

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
    logError("[Hermes Bridge] Error listing sessions:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * List markers for a session
 */
router.get("/sessions/:sessionId/markers", (req, res) => {
  const { sessionId } = req.params;
  const vaultPath = req.vaultPath;

  try {
    const markersPath = getMarkersPath(vaultPath, sessionId);
    const markers = loadMarkers(markersPath);
    res.json({ markers });
  } catch (error) {
    logError("[Hermes Bridge] Error loading markers:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * List touched notes for a session — the causal working set of vault files
 * the agent actually opened/wrote/edited during this session (vs. the
 * similarity-based RelevantNotes).
 */
router.get("/sessions/:sessionId/touched", (req, res) => {
  const { sessionId } = req.params;
  const vaultPath = req.vaultPath;

  try {
    const touched = loadTouched(sessionId, vaultPath);
    res.json(touched);
  } catch (error) {
    logError("[Hermes Bridge] Error loading touched notes:", error);
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
    logError("[Hermes Bridge] Error updating session:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a session and all associated files
 */
router.delete("/sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const vaultPath = req.vaultPath;

  try {
    deleteSession(vaultPath, sessionId);
    log(`[Hermes Bridge] Deleted session ${sessionId}`);
    res.json({ deleted: true });
  } catch (error) {
    logError("[Hermes Bridge] Error deleting session:", error);
    res.status(error.message?.includes("not found") ? 404 : 500).json({ error: error.message });
  }
});

/**
 * Migrate: scan all JSONL files to populate registry
 */
router.post("/sessions/migrate", (req, res) => {
  const vaultPath = req.vaultPath;

  try {
    const projectDir = getProjectDir(vaultPath);
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
        model: "hermes", // Hermes owns the concrete provider/model selection
        messageCount,
        files: filePaths,
      });
      migrated++;
    }

    saveRegistry(vaultPath, registry);
    log(`[Hermes Bridge] Migration complete: ${migrated} sessions migrated`);
    res.json({ migrated });
  } catch (error) {
    logError("[Hermes Bridge] Migration error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
