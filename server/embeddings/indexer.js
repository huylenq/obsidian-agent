import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";
import { log, logError } from "../log.js";
import { chunkMarkdown } from "./chunker.js";
import { embedTexts } from "./embed.js";
import { upsertChunks, deleteByPaths, getIndexedMtimes } from "./lanceIndex.js";

const SKIP_DIRS = new Set([".obsidian", ".obsidian-mobile", ".claude", ".trash", "node_modules", ".git"]);
const EMBED_BATCH = 50;

/** Shared indexing state for status reporting. */
export const indexState = {
  indexing: false,
  progress: null, // { indexed, total }
  lastBuiltAt: null,
};

/**
 * Walk vault directory recursively, collecting .md file paths and mtimes.
 */
async function walkVault(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walkVault(join(dir, entry.name), base)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const fullPath = join(dir, entry.name);
      const relPath = fullPath.slice(base.length + 1); // vault-relative
      const fileStat = await stat(fullPath);
      files.push({ fullPath, relPath, mtime: fileStat.mtimeMs });
    }
  }

  return files;
}

/**
 * Build or incrementally update the LanceDB index for a vault.
 */
export async function buildIndex(vaultPath, table) {
  if (indexState.indexing) {
    log("[Indexer] Already indexing, skipping");
    return { indexed: 0, skipped: 0, deleted: 0 };
  }

  indexState.indexing = true;
  indexState.progress = { indexed: 0, total: 0 };

  try {
    log("[Indexer] Scanning vault:", vaultPath);
    const vaultFiles = await walkVault(vaultPath);
    log("[Indexer] Found", vaultFiles.length, "markdown files");

    // Get existing index state
    const indexedMtimes = await getIndexedMtimes(table);

    // Determine which files need (re-)indexing
    const toIndex = [];
    const currentPaths = new Set();

    for (const file of vaultFiles) {
      currentPaths.add(file.relPath);
      const existingMtime = indexedMtimes.get(file.relPath);
      if (!existingMtime || file.mtime > existingMtime) {
        toIndex.push(file);
      }
    }

    // Find deleted files
    const deletedPaths = [];
    for (const path of indexedMtimes.keys()) {
      if (!currentPaths.has(path)) {
        deletedPaths.push(path);
      }
    }

    if (deletedPaths.length > 0) {
      log("[Indexer] Removing", deletedPaths.length, "deleted files from index");
      await deleteByPaths(table, deletedPaths);
    }

    indexState.progress.total = toIndex.length;
    log("[Indexer]", toIndex.length, "files to index,", vaultFiles.length - toIndex.length, "up to date");

    if (toIndex.length === 0) {
      indexState.indexing = false;
      indexState.lastBuiltAt = Date.now();
      return { indexed: 0, skipped: vaultFiles.length, deleted: deletedPaths.length };
    }

    // Process in batches
    let indexed = 0;
    let failed = 0;
    for (let i = 0; i < toIndex.length; i += EMBED_BATCH) {
      const batch = toIndex.slice(i, i + EMBED_BATCH);

      try {
        // Read and chunk all files in this batch
        const allChunks = [];
        const fileMtimes = [];
        for (const file of batch) {
          const content = await readFile(file.fullPath, "utf-8");
          const chunks = chunkMarkdown(content, file.relPath);
          for (const chunk of chunks) {
            // Skip empty chunks (empty files or frontmatter-only)
            if (!chunk.content.trim()) continue;
            allChunks.push(chunk);
            fileMtimes.push(file.mtime);
          }
        }

        if (allChunks.length === 0) {
          indexed += batch.length;
          indexState.progress.indexed = indexed;
          continue;
        }

        // Embed all chunks in this batch
        const texts = allChunks.map((c) => c.content);
        const vectors = await embedTexts(texts);
        if (!vectors) {
          log("[Indexer] No API key — aborting index build");
          indexState.indexing = false;
          return { indexed: 0, skipped: 0, deleted: deletedPaths.length };
        }

        // Upsert grouped by file (same mtime per file's chunks)
        const byFile = new Map();
        for (let j = 0; j < allChunks.length; j++) {
          const path = allChunks[j].path;
          if (!byFile.has(path)) byFile.set(path, { chunks: [], vectors: [], mtime: fileMtimes[j] });
          byFile.get(path).chunks.push(allChunks[j]);
          byFile.get(path).vectors.push(vectors[j]);
        }

        for (const [, group] of byFile) {
          await upsertChunks(table, group.chunks, group.vectors, group.mtime);
        }

        indexed += batch.length;
      } catch (err) {
        failed += batch.length;
        logError("[Indexer] Batch failed, skipping:", err.message);
      }

      indexState.progress.indexed = indexed + failed;
      log("[Indexer] Progress:", indexed + failed, "/", toIndex.length, failed ? `(${failed} failed)` : "");
    }

    indexState.lastBuiltAt = Date.now();
    log("[Indexer] Done.", indexed, "files indexed,", deletedPaths.length, "deleted");
    return { indexed, skipped: vaultFiles.length - toIndex.length, deleted: deletedPaths.length };
  } catch (err) {
    logError("[Indexer] Build failed:", err);
    throw err;
  } finally {
    indexState.indexing = false;
  }
}
