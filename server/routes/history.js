import { Router } from "express";
import { existsSync, readFileSync } from "fs";
import { log, logError } from "../log.js";
import { getTranscriptPath, getSummariesPath, extractTextFromEntry, extractImagesFromEntry, loadSummaries } from "../transcript.js";
import { getMarkersPath, loadMarkers } from "../markers.js";
import { computeToolDescription, computeToolStructured, formatToolInput, extractToolResultContent } from "../toolFormat.js";

const router = Router();

/**
 * Get session history from transcript file
 * The bridge stores display transcripts at
 * ~/.hermes/obsidian-agent/projects/{encoded-path}/{session-id}.jsonl.
 */
router.post("/history", (req, res) => {
  const { sessionId } = req.body;
  const vaultPath = req.vaultPath;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  log("[Hermes Bridge] Fetching history for session:", sessionId);

  try {
    const transcriptPath = getTranscriptPath(vaultPath, sessionId);

    if (!existsSync(transcriptPath)) {
      log("[Hermes Bridge] Transcript file not found at:", transcriptPath);
      return res.json({ messages: [] });
    }

    log("[Hermes Bridge] Reading transcript from:", transcriptPath);

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
        } else if (entry.type === "assistant") {
          captureNextUserForBoundary = false;

          // Parse message content blocks
          const msg = typeof entry.message === "string" ? JSON.parse(entry.message) : entry.message;
          const contentBlocks = Array.isArray(msg?.content) ? msg.content : [];

          // Extract text blocks
          const textParts = contentBlocks.filter(b => b.type === "text").map(b => b.text);
          const textContent = textParts.join("");

          // Filter compaction artifacts
          if (/^compacted$/i.test(textContent.trim())) continue;
          if (textContent.includes("<local-command-caveat>")) continue;

          // Emit text message if there's text
          if (textContent) {
            messages.push({
              role: "assistant",
              content: textContent,
              timestamp: entry.timestamp || Date.now(),
            });
          }

          // Extract tool_use blocks
          const toolUseBlocks = contentBlocks.filter(b => b.type === "tool_use");
          if (toolUseBlocks.length > 0) {
            messages.push({
              role: "tool_block",
              content: "",
              timestamp: entry.timestamp || Date.now(),
              toolBlocks: toolUseBlocks.map(b => ({
                toolUseId: b.id,
                toolName: b.name,
                description: computeToolDescription(b.name, b.input),
                input: formatToolInput(b.name, b.input),
                isRunning: false,
                ...computeToolStructured(b.name, b.input, vaultPath),
              })),
            });
          }
        } else if (entry.type === "user") {
          if (captureNextUserForBoundary) {
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

          // Tool result — attach output to the most recent tool_block
          if (entry.toolUseResult !== undefined) {
            const msg = typeof entry.message === "string" ? JSON.parse(entry.message) : entry.message;
            const contentBlocks = Array.isArray(msg?.content) ? msg.content : [];
            const toolResultBlock = contentBlocks.find(b => b.type === "tool_result");
            if (toolResultBlock) {
              const result = extractToolResultContent(entry);
              // Find the matching tool block and attach output
              const lastToolMsg = messages.findLast(m => m.role === "tool_block");
              if (lastToolMsg?.toolBlocks) {
                const match = lastToolMsg.toolBlocks.find(tb => tb.toolUseId === toolResultBlock.tool_use_id);
                if (match) {
                  match.output = result.text;
                  match.isError = result.isError;
                }
              }
            }
            continue;
          }

          // Regular user message
          const textContent = extractTextFromEntry(entry);
          const images = extractImagesFromEntry(entry);
          if (!textContent && images.length === 0) continue;

          // Filter compaction artifacts
          if (textContent && /^\/compact\b/.test(textContent.trim())) continue;
          if (textContent && textContent.includes("<local-command-caveat>")) continue;

          messages.push({
            role: "user",
            content: textContent,
            timestamp: entry.timestamp || Date.now(),
            ...(images.length > 0 && { images }),
          });
        }
      } catch (parseError) {
        // Skip malformed lines
        log("[Hermes Bridge] Skipping malformed line");
      }
    }

    // Attach saved summaries to compact_boundary entries
    const summariesPath = getSummariesPath(vaultPath, sessionId);
    const summaries = loadSummaries(summariesPath);
    let summaryIdx = 0;
    for (const msg of messages) {
      if (msg.role === "compact_boundary" && summaryIdx < summaries.length) {
        msg.compactMetadata.summary = summaries[summaryIdx].summary;
        summaryIdx++;
      }
    }

    // Annotate user messages with marker metadata from markers sidecar
    const markersPath = getMarkersPath(vaultPath, sessionId);
    const markers = loadMarkers(markersPath);
    if (markers.length > 0) {
      const userMessagePositions = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "user") {
          userMessagePositions.push(i);
        }
      }

      for (const marker of markers) {
        const idx = marker.userMessageIndex;
        const pos = idx < userMessagePositions.length
          ? userMessagePositions[idx]
          : -1;
        if (pos >= 0) {
          messages[pos].markerMetadata = {
            markerId: marker.markerId,
            flashcardId: marker.flashcardId,
            sourceFile: marker.sourceFile,
            question: marker.question,
          };
        }
      }
    }

    log("[Hermes Bridge] Found", messages.length, "messages in history");
    res.json({ messages });

  } catch (error) {
    logError("[Hermes Bridge] Error reading history:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
