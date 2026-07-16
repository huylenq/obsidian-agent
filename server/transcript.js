import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { getProjectDir } from "./storage.js";

export { encodePath } from "./storage.js";

export function getTranscriptPath(workingDirectory, sessionId) {
  return join(getProjectDir(workingDirectory), `${sessionId}.jsonl`);
}

export function getSummariesPath(workingDirectory, sessionId) {
  return join(getProjectDir(workingDirectory), `${sessionId}.summaries.json`);
}

export function appendTranscriptEntry(workingDirectory, sessionId, entry) {
  const transcriptPath = getTranscriptPath(workingDirectory, sessionId);
  mkdirSync(dirname(transcriptPath), { recursive: true });
  appendFileSync(transcriptPath, `${JSON.stringify({ timestamp: Date.now(), ...entry })}\n`);
}

/** Extract text content from a transcript entry's message field */
export function extractTextFromEntry(entry) {
  if (!entry.message) return "";
  const msg = typeof entry.message === "string" ? JSON.parse(entry.message) : entry.message;
  if (!msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
  }
  return "";
}

/**
 * Extract image content blocks from a transcript entry.
 * Returns an array of { data, mediaType, name? } or empty array.
 */
export function extractImagesFromEntry(entry) {
  if (!entry.message) return [];
  const msg = typeof entry.message === "string" ? JSON.parse(entry.message) : entry.message;
  if (!Array.isArray(msg?.content)) return [];
  return msg.content
    .filter(block => block.type === "image" && block.source?.type === "base64")
    .map(block => ({
      data: block.source.data,
      mediaType: block.source.media_type,
    }));
}

/** Read user/assistant messages from the latest segment (after last compact_boundary) */
export function readLatestSegmentMessages(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  let segment = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "system" && entry.subtype === "compact_boundary") {
        segment = []; // reset — only keep messages after the latest boundary
      } else if (entry.type === "user" || entry.type === "assistant") {
        const text = extractTextFromEntry(entry);
        if (text) segment.push({ role: entry.type, content: text });
      }
    } catch { /* skip malformed */ }
  }
  return segment;
}

export function loadSummaries(summariesPath) {
  if (!existsSync(summariesPath)) return [];
  try {
    return JSON.parse(readFileSync(summariesPath, "utf-8"));
  } catch { return []; }
}

export function appendSummary(summariesPath, entry) {
  const summaries = loadSummaries(summariesPath);
  summaries.push(entry);
  writeFileSync(summariesPath, JSON.stringify(summaries, null, 2));
}
