import * as lancedb from "@lancedb/lancedb";
import * as arrow from "apache-arrow";
import { log } from "../log.js";
import { DIMENSIONS } from "./embed.js";

const TABLE_NAME = "notes";

const SCHEMA = new arrow.Schema([
  new arrow.Field("id", new arrow.Utf8()),
  new arrow.Field("path", new arrow.Utf8()),
  new arrow.Field("title", new arrow.Utf8()),
  new arrow.Field("content", new arrow.Utf8()),
  new arrow.Field(
    "vector",
    new arrow.FixedSizeList(
      DIMENSIONS,
      new arrow.Field("item", new arrow.Float32(), true)
    )
  ),
  new arrow.Field("mtime", new arrow.Float64()),
  new arrow.Field("chunkIndex", new arrow.Int32()),
]);

/**
 * Connect to a LanceDB database at the given directory.
 */
export async function connect(dbPath) {
  return lancedb.connect(dbPath);
}

/**
 * Open existing table or create a new empty one.
 */
export async function getOrCreateTable(db) {
  const tables = await db.tableNames();
  if (tables.includes(TABLE_NAME)) {
    return db.openTable(TABLE_NAME);
  }
  // Create empty table with schema
  const empty = lancedb.makeArrowTable([], { schema: SCHEMA });
  return db.createTable(TABLE_NAME, empty);
}

/**
 * Upsert chunks with their embedding vectors into the table.
 * chunks: Array of { id, path, title, content, chunkIndex }
 * vectors: Array of number[] (parallel to chunks)
 * mtime: file mtime for all chunks (same file)
 */
export async function upsertChunks(table, chunks, vectors, mtime) {
  const rows = chunks.map((chunk, i) => ({
    id: chunk.id,
    path: chunk.path,
    title: chunk.title,
    content: chunk.content,
    vector: vectors[i],
    mtime,
    chunkIndex: chunk.chunkIndex,
  }));

  const data = lancedb.makeArrowTable(rows, { schema: SCHEMA });
  await table
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(data);
}

/**
 * Delete all chunks for paths that no longer exist.
 */
export async function deleteByPaths(table, paths) {
  if (paths.length === 0) return;
  const quoted = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(", ");
  await table.delete(`path IN (${quoted})`);
}

/**
 * Search by vector, deduplicate by path (keep highest score per note).
 */
export async function searchByVector(table, queryVector, opts = {}) {
  const { limit = 10, excludePath, minSimilarity = 0.4 } = opts;

  let query = table.search(queryVector).limit(limit * 3);

  const results = await query.toArray();

  // Deduplicate by path, keep highest scoring chunk
  const byPath = new Map();
  for (const row of results) {
    if (excludePath && row.path === excludePath) continue;
    const score = 1 - (row._distance || 0); // LanceDB returns distance, convert to similarity
    if (score < minSimilarity) continue;

    const existing = byPath.get(row.path);
    if (!existing || score > existing.similarity) {
      byPath.set(row.path, {
        path: row.path,
        title: row.title,
        content: row.content?.slice(0, 500) || "",
        similarity: score,
      });
    }
  }

  return Array.from(byPath.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Search for notes similar to a given path by looking up its stored vector.
 * Falls back to null if the path isn't indexed.
 */
export async function searchByPath(table, path, opts = {}) {
  // Look up the stored vector for this path (first chunk)
  const rows = await table
    .query()
    .where(`path = '${path.replace(/'/g, "''")}'`)
    .where("`chunkIndex` = 0")
    .limit(1)
    .toArray();

  if (rows.length === 0) return null;

  const vector = Array.from(rows[0].vector);
  return searchByVector(table, vector, { ...opts, excludePath: path });
}

/**
 * Get stored embedding vectors for a list of paths.
 * Returns Map<path, number[]> (uses first chunk's embedding per path).
 */
export async function getVectorsForPaths(table, paths) {
  if (paths.length === 0) return new Map();

  const quoted = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(", ");
  const rows = await table
    .query()
    .where(`path IN (${quoted}) AND \`chunkIndex\` = 0`)
    .limit(paths.length)
    .toArray();

  const result = new Map();
  for (const row of rows) {
    result.set(row.path, Array.from(row.vector));
  }
  return result;
}

/**
 * Get all indexed paths with their mtimes.
 * Returns Map<path, mtime>.
 */
export async function getIndexedMtimes(table) {
  const total = await table.countRows();
  const rows = await table
    .query()
    .where("`chunkIndex` = 0")
    .select(["path", "mtime"])
    .limit(total || 1)
    .toArray();

  const result = new Map();
  for (const row of rows) {
    result.set(row.path, row.mtime);
  }
  return result;
}

/**
 * Count total documents in the table.
 */
export async function countDocs(table) {
  return table.countRows();
}
