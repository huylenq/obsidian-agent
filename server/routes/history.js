import { Router } from "express";
import { existsSync, readFileSync } from "fs";
import { log, logError } from "../log.js";
import { getTranscriptPath, getSummariesPath, extractTextFromEntry, loadSummaries } from "../transcript.js";

const router = Router();

/**
 * Get session history from transcript file
 * Claude Code stores transcripts at ~/.claude/projects/{encoded-path}/{session-id}.jsonl
 */
router.post("/history", (req, res) => {
  const { sessionId, workingDirectory } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  log("[Proxy] Fetching history for session:", sessionId);

  try {
    const transcriptPath = getTranscriptPath(workingDirectory, sessionId);

    if (!existsSync(transcriptPath)) {
      log("[Proxy] Transcript file not found at:", transcriptPath);
      return res.json({ messages: [] });
    }

    log("[Proxy] Reading transcript from:", transcriptPath);

    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    const messages = [];
    let captureNextUserForBoundary = false;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === "system" && entry.subtype === "compact_boundary") {
          messages.push({
            role: "compact_boundary",
            content: "",
            timestamp: entry.timestamp || Date.now(),
            compactMetadata: {
              preTokens: entry.compact_metadata?.pre_tokens || 0,
              trigger: entry.compact_metadata?.trigger || "manual",
            },
          });
          // The SDK injects a synthetic user message after compact_boundary
          // containing its internal context summary — capture it for the boundary UI
          captureNextUserForBoundary = true;
        } else if (entry.type === "user" || entry.type === "assistant") {
          if (captureNextUserForBoundary && entry.type === "user") {
            captureNextUserForBoundary = false;
            const textContent = extractTextFromEntry(entry);
            if (textContent) {
              // Attach to the most recent compact_boundary
              const lastBoundary = messages.findLast(m => m.role === "compact_boundary");
              if (lastBoundary) {
                lastBoundary.compactMetadata.sdkSummary = textContent;
              }
            }
            continue;
          }
          captureNextUserForBoundary = false;
          const textContent = extractTextFromEntry(entry);
          if (!textContent) continue;

          // Filter out compaction artifacts from transcript
          if (entry.type === "user" && /^\/compact\b/.test(textContent.trim())) continue;
          if (entry.type === "assistant" && /^compacted$/i.test(textContent.trim())) continue;
          // Skip system-injected local-command caveats
          if (textContent.includes("<local-command-caveat>")) continue;

          messages.push({
            role: entry.type,
            content: textContent,
            timestamp: entry.timestamp || Date.now(),
          });
        }
      } catch (parseError) {
        // Skip malformed lines
        log("[Proxy] Skipping malformed line");
      }
    }

    // Attach saved summaries to compact_boundary entries
    const summariesPath = getSummariesPath(workingDirectory, sessionId);
    const summaries = loadSummaries(summariesPath);
    let summaryIdx = 0;
    for (const msg of messages) {
      if (msg.role === "compact_boundary" && summaryIdx < summaries.length) {
        msg.compactMetadata.summary = summaries[summaryIdx].summary;
        summaryIdx++;
      }
    }

    log("[Proxy] Found", messages.length, "messages in history");
    res.json({ messages });

  } catch (error) {
    logError("[Proxy] Error reading history:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
