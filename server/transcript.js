import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { log, logError } from "./log.js";

const COMPACT_SUMMARY_CWD = "/tmp/claude-agent-compact-summaries";

export function encodePath(workingDirectory) {
  return workingDirectory ? workingDirectory.replace(/[\/\s~]/g, "-") : "";
}

export function getTranscriptPath(workingDirectory, sessionId) {
  return join(homedir(), ".claude", "projects", encodePath(workingDirectory), `${sessionId}.jsonl`);
}

export function getSummariesPath(workingDirectory, sessionId) {
  return join(homedir(), ".claude", "projects", encodePath(workingDirectory), `${sessionId}.summaries.json`);
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

/** Generate a compact summary via Agent SDK with a throwaway /tmp session */
export async function generateCompactSummary(messages) {
  if (messages.length === 0) return null;

  // Cap at 30 messages, truncate each to 300 chars
  const capped = messages.slice(-30);
  const conversationText = capped
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `Summarize this conversation in 2-3 concise bullet points using the bullet character. Focus on topics discussed and key outcomes. Be very brief — no preamble.\n\nConversation:\n${conversationText}`;

  mkdirSync(COMPACT_SUMMARY_CWD, { recursive: true });

  try {
    log("[Proxy] Generating compact summary...");
    const response = query({
      prompt,
      options: {
        model: "haiku",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        cwd: COMPACT_SUMMARY_CWD,
        systemPrompt: "You are a conversation summarizer. Output only bullet points, nothing else. Use the bullet character for each point.",
      },
    });

    let summary = "";
    for await (const msg of response) {
      if (msg.type === "assistant") {
        if (typeof msg.content === "string") {
          summary = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") summary += block.text;
          }
        }
        if (msg.message?.content && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === "text") summary += block.text;
          }
        }
      }
    }

    const trimmed = summary.trim();
    log("[Proxy] Compact summary generated:", trimmed.slice(0, 200));
    return trimmed || null;
  } catch (error) {
    logError("[Proxy] Failed to generate compact summary:", error);
    return null;
  }
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
