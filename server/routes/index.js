import { Router } from "express";
import { log, logError } from "../log.js";
import { embedTexts } from "../embeddings/embed.js";
import {
  searchByVector,
  searchByPath,
  getVectorsForPaths,
  countDocs,
} from "../embeddings/lanceIndex.js";
import { buildIndex, indexState } from "../embeddings/indexer.js";

const router = Router();

/**
 * POST /index/search — search by free text (embeds the query first)
 */
router.post("/index/search", async (req, res) => {
  try {
    const { queryText, excludePath, limit = 10, minSimilarity = 0.4 } = req.body;
    if (!queryText) return res.status(400).json({ error: "queryText required" });
    if (!req.lanceTable) return res.status(503).json({ error: "Index not available" });

    const vectors = await embedTexts([queryText]);
    if (!vectors) return res.status(503).json({ error: "OPENAI_API_KEY not set" });

    const results = await searchByVector(req.lanceTable, vectors[0], {
      limit,
      excludePath,
      minSimilarity,
    });

    res.json({ results });
  } catch (err) {
    logError("[/index/search]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /index/search-by-path — search for notes similar to a given path
 */
router.post("/index/search-by-path", async (req, res) => {
  try {
    const { path, excludePath, limit = 10, minSimilarity = 0.4 } = req.body;
    if (!path) return res.status(400).json({ error: "path required" });
    if (!req.lanceTable) return res.status(503).json({ error: "Index not available" });

    const results = await searchByPath(req.lanceTable, path, {
      limit,
      excludePath: excludePath || path,
      minSimilarity,
    });

    if (results === null) {
      return res.json({ results: [], inIndex: false });
    }

    res.json({ results, inIndex: true });
  } catch (err) {
    logError("[/index/search-by-path]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /index/pairwise — compute pairwise similarity for a list of paths
 */
router.post("/index/pairwise", async (req, res) => {
  try {
    const { paths, threshold = 0.4 } = req.body;
    if (!Array.isArray(paths)) return res.status(400).json({ error: "paths array required" });
    if (!req.lanceTable) return res.status(503).json({ error: "Index not available" });

    const vectors = await getVectorsForPaths(req.lanceTable, paths);
    const indexedPaths = Array.from(vectors.keys());

    // O(n²) cosine similarity
    const edges = [];
    for (let i = 0; i < indexedPaths.length; i++) {
      const a = vectors.get(indexedPaths[i]);
      for (let j = i + 1; j < indexedPaths.length; j++) {
        const b = vectors.get(indexedPaths[j]);
        const sim = cosineSimilarity(a, b);
        if (sim >= threshold) {
          edges.push({ source: indexedPaths[i], target: indexedPaths[j], similarity: sim });
        }
      }
    }

    // Cap at 300 edges, sorted by score
    edges.sort((a, b) => b.similarity - a.similarity);
    res.json({
      edges: edges.slice(0, 300),
      indexedPaths, // so client can set inVectorIndex flags
    });
  } catch (err) {
    logError("[/index/pairwise]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /index/rebuild — trigger a full index rebuild in the background
 */
router.post("/index/rebuild", async (req, res) => {
  if (!req.lanceTable) return res.status(503).json({ error: "Index not available" });

  // Fire and forget
  buildIndex(req.vaultPath, req.lanceTable).catch((err) =>
    logError("[/index/rebuild]", err)
  );

  res.json({ status: "started" });
});

/**
 * GET /index/status — current index state
 */
router.get("/index/status", async (req, res) => {
  try {
    const docCount = req.lanceTable ? await countDocs(req.lanceTable) : 0;
    res.json({
      ready: !!req.lanceTable && !indexState.indexing,
      available: !!req.lanceTable,
      docCount,
      indexing: indexState.indexing,
      progress: indexState.progress,
      lastBuiltAt: indexState.lastBuiltAt,
    });
  } catch (err) {
    res.json({ ready: false, available: false, docCount: 0, indexing: false });
  }
});

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const mag = Math.sqrt(normA) * Math.sqrt(normB);
  return mag === 0 ? 0 : dot / mag;
}

export default router;
