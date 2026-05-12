import { TFile, type App } from "obsidian";

/** Vault note basename without the .md extension. */
export function basenameNoExt(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/i, "");
}

/**
 * Resolve a vault-relative path (or a linkpath shorthand like "Note Title") to
 * a TFile. Tries the direct path first, then falls back to Obsidian's
 * linkpath resolver. Returns null when nothing matches.
 */
export function resolveVaultFile(app: App, path: string): TFile | null {
  const direct = app.vault.getAbstractFileByPath(path);
  if (direct instanceof TFile) return direct;
  return app.metadataCache.getFirstLinkpathDest(path, "");
}
