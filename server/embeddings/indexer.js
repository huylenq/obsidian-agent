import { readdir, stat, readFile, writeFile, rename } from "fs/promises";
import { join } from "path";
import { log, logError } from "../log.js";
import { chunkMarkdown } from "./chunker.js";
import { embedTexts } from "./embed.js";
import { upsertChunks, deleteByPaths, getIndexedMtimes } from "./lanceIndex.js";

// Keep the former provider directory excluded so existing vault metadata is
// never indexed after an upgrade.
const SKIP_DIRS = new Set([".obsidian", ".obsidian-mobile", ".hermes", ".claude", ".trash", "node_modules", ".git"]);
const EMBED_BATCH = 50;
const EMPTY_FILES_STATE = "empty-files.json";

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

function getEmptyFilesStatePath(vaultPath) {
  return join(vaultPath, ".obsidian", "lance", EMPTY_FILES_STATE);
}

/** Load mtimes for notes that intentionally have no vector rows. */
async function loadEmptyFileMtimes(vaultPath) {
  try {
    const raw = await readFile(getEmptyFilesStatePath(vaultPath), "utf-8");
    const state = JSON.parse(raw);
    if (state.version !== 1 || !Array.isArray(state.entries)) return new Map();
    return new Map(
      state.entries
        .filter((entry) => typeof entry?.path === "string" && Number.isFinite(entry?.mtime))
        .map((entry) => [entry.path, entry.mtime])
    );
  } catch (err) {
    if (err.code !== "ENOENT") {
      logError("[Indexer] Failed to read empty-file state:", err.message);
    }
    return new Map();
  }
}

/** Persist empty-note mtimes atomically so they stay skipped across restarts. */
async function saveEmptyFileMtimes(vaultPath, mtimes) {
  const statePath = getEmptyFilesStatePath(vaultPath);
  const tempPath = `${statePath}.${process.pid}.tmp`;
  const state = {
    version: 1,
    entries: Array.from(mtimes, ([path, mtime]) => ({ path, mtime })),
  };
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await rename(tempPath, statePath);
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
  let emptyFileMtimes = null;
  let emptyFileStateDirty = false;

  try {
    log("[Indexer] Scanning vault:", vaultPath);
    const vaultFiles = await walkVault(vaultPath);
    log("[Indexer] Found", vaultFiles.length, "markdown files");

    // Get existing index state
    const indexedMtimes = await getIndexedMtimes(table);
    emptyFileMtimes = await loadEmptyFileMtimes(vaultPath);

    // Determine which files need (re-)indexing
    const toIndex = [];
    const currentPaths = new Set();

    for (const file of vaultFiles) {
      currentPaths.add(file.relPath);
      const vectorMtime = indexedMtimes.get(file.relPath);
      const emptyMtime = emptyFileMtimes.get(file.relPath);
      const existingMtime = Math.max(vectorMtime || 0, emptyMtime || 0);
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
    for (const path of emptyFileMtimes.keys()) {
      if (!currentPaths.has(path)) {
        emptyFileMtimes.delete(path);
        emptyFileStateDirty = true;
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
    let emptySkipped = 0;
    let failed = 0;
    for (let i = 0; i < toIndex.length; i += EMBED_BATCH) {
      const batch = toIndex.slice(i, i + EMBED_BATCH);
      let batchEmptyCount = 0;

      try {
        // Read and chunk all files in this batch
        const allChunks = [];
        const fileMtimes = [];
        const emptyFiles = [];
        for (const file of batch) {
          const content = await readFile(file.fullPath, "utf-8");
          const chunks = chunkMarkdown(content, file.relPath);
          if (chunks.length === 0) {
            emptyFiles.push(file);
            continue;
          }
          for (const chunk of chunks) {
            allChunks.push(chunk);
            fileMtimes.push(file.mtime);
          }
        }
        batchEmptyCount = emptyFiles.length;

        // If a formerly indexed note became empty, remove its old vectors.
        await deleteByPaths(table, emptyFiles.map((file) => file.relPath));
        for (const file of emptyFiles) {
          emptyFileMtimes.set(file.relPath, file.mtime);
          emptyFileStateDirty = true;
        }

        if (allChunks.length === 0) {
          emptySkipped += batchEmptyCount;
          indexState.progress.indexed = indexed + emptySkipped + failed;
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

        for (const [path, group] of byFile) {
          await upsertChunks(table, group.chunks, group.vectors, group.mtime);
          if (emptyFileMtimes.delete(path)) emptyFileStateDirty = true;
        }

        indexed += byFile.size;
        emptySkipped += batchEmptyCount;
      } catch (err) {
        emptySkipped += batchEmptyCount;
        failed += batch.length - batchEmptyCount;
        logError("[Indexer] Batch failed, skipping:", err.message);
      }

      indexState.progress.indexed = indexed + emptySkipped + failed;
      log("[Indexer] Progress:", indexState.progress.indexed, "/", toIndex.length, failed ? `(${failed} failed)` : "");
    }

    indexState.lastBuiltAt = Date.now();
    log("[Indexer] Done.", indexed, "files indexed,", emptySkipped, "empty files skipped,", deletedPaths.length, "deleted");
    return {
      indexed,
      skipped: vaultFiles.length - toIndex.length + emptySkipped,
      deleted: deletedPaths.length,
    };
  } catch (err) {
    logError("[Indexer] Build failed:", err);
    throw err;
  } finally {
    if (emptyFileStateDirty && emptyFileMtimes) {
      try {
        await saveEmptyFileMtimes(vaultPath, emptyFileMtimes);
      } catch (err) {
        logError("[Indexer] Failed to save empty-file state:", err.message);
      }
    }
    indexState.indexing = false;
  }
}
