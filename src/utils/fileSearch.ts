import { App, TFile } from "obsidian";

export interface FileSearchResult {
  path: string;
  name: string;
  extension: string;
}

/**
 * Search vault files using fuzzy matching
 * Returns files sorted by relevance (exact prefix match first, then includes match)
 */
export function searchVaultFiles(
  app: App,
  query: string,
  maxResults: number = 10
): FileSearchResult[] {
  if (!query) return [];

  const lowerQuery = query.toLowerCase();
  const files = app.vault.getFiles();

  const scored: Array<{ file: TFile; score: number }> = [];

  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const lowerName = file.name.toLowerCase();

    // Skip if no match at all
    if (!lowerPath.includes(lowerQuery)) continue;

    // Scoring: lower is better
    let score = 0;

    // Exact name match (without extension)
    const nameWithoutExt = lowerName.replace(/\.[^.]+$/, "");
    if (nameWithoutExt === lowerQuery) {
      score = 0;
    }
    // Name starts with query
    else if (lowerName.startsWith(lowerQuery)) {
      score = 1;
    }
    // Name contains query
    else if (lowerName.includes(lowerQuery)) {
      score = 2;
    }
    // Path contains query
    else {
      score = 3;
    }

    // Tie-breaker: shorter paths first
    score += file.path.length / 1000;

    scored.push({ file, score });
  }

  // Sort by score (lower is better)
  scored.sort((a, b) => a.score - b.score);

  return scored.slice(0, maxResults).map(({ file }) => ({
    path: file.path,
    name: file.name,
    extension: file.extension,
  }));
}

/**
 * Get parent folder path from a file path
 */
export function getParentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash > 0 ? path.slice(0, lastSlash) : "";
}
