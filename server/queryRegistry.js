import { log } from "./log.js";

/**
 * In-memory registry of active Claude Agent SDK queries.
 * Key:   queryId (UUID)
 * Value: { query, inputController, sessionId, createdAt }
 */
const activeQueries = new Map();

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export function registerQuery(queryId, query, inputController, sessionId) {
  activeQueries.set(queryId, { query, inputController, sessionId, createdAt: Date.now() });
  log(`[QueryRegistry] Registered query ${queryId} (session: ${sessionId || "pending"})`);
}

export function getQuery(queryId) {
  return activeQueries.get(queryId) || null;
}

export function removeQuery(queryId) {
  const existed = activeQueries.delete(queryId);
  if (existed) {
    log(`[QueryRegistry] Removed query ${queryId}`);
  }
  return existed;
}

/**
 * Update the sessionId for a registered query (set once the SDK init message arrives).
 */
export function updateQuerySession(queryId, sessionId) {
  const entry = activeQueries.get(queryId);
  if (entry) {
    entry.sessionId = sessionId;
  }
}

// Periodic cleanup of stale queries
setInterval(() => {
  const now = Date.now();
  for (const [queryId, entry] of activeQueries) {
    if (now - entry.createdAt > TIMEOUT_MS) {
      log(`[QueryRegistry] Timing out query ${queryId} (age: ${Math.round((now - entry.createdAt) / 1000)}s)`);
      entry.inputController.close();
      activeQueries.delete(queryId);
    }
  }
}, 60_000).unref(); // unref so the timer doesn't keep the process alive
