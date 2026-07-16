import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getProjectDir } from "./storage.js";
import { logError } from "./log.js";

/**
 * Touched-notes sidecar — records the *causal* working set of vault notes
 * for a session: every file the agent actually opened (Read), wrote (Write),
 * or modified (Edit) during the session. Distinct from RelevantNotes which
 * is similarity-based.
 *
 * File layout: ~/.hermes/obsidian-agent/projects/{encoded-path}/{sessionId}.touched.json
 *
 * @typedef {Object} TouchedEntry
 * @property {string} path     - Vault-relative or absolute file path (whatever
 *                                the SDK tool block reported).
 * @property {"read"|"write"|"edit"} op  - Latest operation performed on the path.
 * @property {number} count    - Number of times this path has been touched
 *                                across any op (read/write/edit).
 * @property {number} firstAt  - Epoch ms of first touch.
 * @property {number} lastAt   - Epoch ms of most recent touch.
 *
 * @typedef {Object} TouchedFile
 * @property {1} version
 * @property {TouchedEntry[]} entries
 */

const CURRENT_VERSION = 1;

/** Resolve the sidecar path for a session. */
export function getTouchedPath(sessionId, workingDirectory) {
  return join(getProjectDir(workingDirectory), `${sessionId}.touched.json`);
}

/**
 * Load touched-notes for a session. Returns an empty default if the file
 * does not exist or is unreadable — never throws.
 *
 * @param {string} sessionId
 * @param {string} workingDirectory
 * @returns {TouchedFile}
 */
export function loadTouched(sessionId, workingDirectory) {
  const touchedPath = getTouchedPath(sessionId, workingDirectory);
  if (!existsSync(touchedPath)) return { version: CURRENT_VERSION, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(touchedPath, "utf-8"));
    // Defensive: tolerate a malformed/legacy shape and coerce.
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return { version: CURRENT_VERSION, entries: [] };
    }
    return { version: parsed.version || CURRENT_VERSION, entries: parsed.entries };
  } catch (err) {
    logError("[touchedNotes] Failed to read", touchedPath, err);
    return { version: CURRENT_VERSION, entries: [] };
  }
}

/**
 * Append a batch of touch entries to the sidecar. Dedups by `path` —
 * a later op on the same path REPLACES the stored op (so an Edit after a
 * Read promotes the entry to "edit"). Atomic write via temp + rename.
 *
 * @param {string} sessionId
 * @param {string} workingDirectory
 * @param {Array<{ path: string, op: "read"|"write"|"edit", at?: number }>} newTouches
 */
export function appendTouched(sessionId, workingDirectory, newTouches) {
  if (!sessionId || !workingDirectory) return;
  if (!Array.isArray(newTouches) || newTouches.length === 0) return;

  try {
    const touchedPath = getTouchedPath(sessionId, workingDirectory);
    const data = loadTouched(sessionId, workingDirectory);

    // Index existing entries by path for O(1) merge.
    const byPath = new Map();
    for (const entry of data.entries) {
      byPath.set(entry.path, entry);
    }

    for (const touch of newTouches) {
      if (!touch || !touch.path || !touch.op) continue;
      const at = touch.at || Date.now();
      const existing = byPath.get(touch.path);
      if (existing) {
        existing.op = touch.op;        // promote to latest op
        existing.count = (existing.count || 0) + 1;
        existing.lastAt = at;
        if (!existing.firstAt) existing.firstAt = at;
      } else {
        const entry = {
          path: touch.path,
          op: touch.op,
          count: 1,
          firstAt: at,
          lastAt: at,
        };
        byPath.set(touch.path, entry);
        data.entries.push(entry);
      }
    }

    data.version = CURRENT_VERSION;

    // Atomic write: temp file in same dir, then rename.
    const dir = dirname(touchedPath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${touchedPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, touchedPath);
  } catch (err) {
    logError("[touchedNotes] Failed to append touches:", err);
  }
}
