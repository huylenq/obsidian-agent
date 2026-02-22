import { readFileSync, existsSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { encodePath } from "./transcript.js";

export function getMarkersPath(workingDirectory, sessionId) {
  return join(homedir(), ".claude", "projects", encodePath(workingDirectory), `${sessionId}.markers.json`);
}

export function loadMarkers(markersPath) {
  // Lazy file migration: .threads.json → .markers.json
  if (!existsSync(markersPath)) {
    const legacyPath = markersPath.replace(/\.markers\.json$/, ".threads.json");
    if (existsSync(legacyPath)) {
      renameSync(legacyPath, markersPath);
    } else {
      return [];
    }
  }
  try {
    const markers = JSON.parse(readFileSync(markersPath, "utf-8"));
    // Lazy field migration: startMessageIndex → userMessageIndex, threadId → markerId
    let migrated = false;
    for (const m of markers) {
      if ("startMessageIndex" in m && !("userMessageIndex" in m)) {
        m.userMessageIndex = m.startMessageIndex;
        delete m.startMessageIndex;
        migrated = true;
      }
      if ("threadId" in m && !("markerId" in m)) {
        m.markerId = m.threadId;
        delete m.threadId;
        migrated = true;
      }
    }
    if (migrated) {
      writeFileSync(markersPath, JSON.stringify(markers, null, 2));
    }
    return markers;
  } catch { return []; }
}

export function appendMarker(markersPath, entry) {
  const markers = loadMarkers(markersPath);
  markers.push(entry);
  writeFileSync(markersPath, JSON.stringify(markers, null, 2));
}
