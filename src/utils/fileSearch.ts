import { App, TAbstractFile, TFile, TFolder } from "obsidian";

export interface FileSearchResult {
  path: string;
  name: string;
  extension: string;
  type: "file" | "folder";
}

/**
 * Search vault files and folders using fuzzy matching
 * Returns items sorted by relevance (exact prefix match first, then includes match)
 */
export function searchVaultItems(
  app: App,
  query: string,
  maxResults: number = 10
): FileSearchResult[] {
  if (!query) return [];

  const lowerQuery = query.toLowerCase();
  const allItems = app.vault.getAllLoadedFiles();

  const scored: Array<{ item: TAbstractFile; score: number }> = [];

  for (const item of allItems) {
    // Skip root folder
    if (item.path === "/") continue;

    const isFolder = item instanceof TFolder;
    const lowerPath = item.path.toLowerCase();
    const lowerName = item.name.toLowerCase();

    // Skip if no match at all
    if (!lowerPath.includes(lowerQuery)) continue;

    // Scoring: lower is better
    let score = 0;

    // Exact name match (without extension for files)
    const nameWithoutExt = isFolder ? lowerName : lowerName.replace(/\.[^.]+$/, "");
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
    score += item.path.length / 1000;

    scored.push({ item, score });
  }

  // Sort by score (lower is better)
  scored.sort((a, b) => a.score - b.score);

  return scored.slice(0, maxResults).map(({ item }) => {
    const isFolder = item instanceof TFolder;
    return {
      path: item.path,
      name: item.name,
      extension: isFolder ? "" : (item as TFile).extension,
      type: isFolder ? "folder" : "file",
    };
  });
}

/**
 * Get parent folder path from a file path
 */
export function getParentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash > 0 ? path.slice(0, lastSlash) : "";
}
