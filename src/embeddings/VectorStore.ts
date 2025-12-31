/**
 * CopilotIndexReader - Reads from obsidian-copilot's existing Orama vector index
 *
 * This implementation directly reads the serialized index files without using
 * Orama's load() function, making it version-independent.
 */

import type { App } from "obsidian";
import type { RelevantNote } from "../types";

const CHUNK_PREFIX = "copilot-index-chunk-";

interface ChunkMetadata {
  numPartitions: number;
  vectorLength: string;
  schema: Record<string, string>;
  lastModified: number;
  documentPartitions: Record<string, number>;
}

interface IndexedDocument {
  id: string;
  path: string;
  title: string;
  content: string;
  mtime: number;
}

export interface SearchOptions {
  minSimilarity?: number;
  limit?: number;
  excludePath?: string;
}

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

export class CopilotIndexReader {
  private documents: Map<string, IndexedDocument> = new Map();
  private vectors: Map<string, number[]> = new Map();
  private initialized = false;

  constructor(private app: App) {}

  /**
   * Find and load Copilot's index from the vault's .obsidian directory
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      const configDir = this.app.vault.configDir;
      console.log("[CopilotIndexReader] Config dir:", configDir);

      // Find the metadata file
      const files = await this.app.vault.adapter.list(configDir);
      const metadataFile = files.files.find(
        (f) => f.includes(CHUNK_PREFIX) && f.endsWith("-metadata.json")
      );

      if (!metadataFile) {
        console.log("[CopilotIndexReader] No Copilot index found");
        return false;
      }

      // Extract identifier
      const match = metadataFile.match(/copilot-index-chunk-(.+)-metadata\.json$/);
      if (!match) {
        console.error("[CopilotIndexReader] Could not parse metadata filename");
        return false;
      }
      const indexIdentifier = match[1];

      // Load metadata
      const metadataContent = await this.app.vault.adapter.read(metadataFile);
      const metadata: ChunkMetadata = JSON.parse(metadataContent);

      console.log("[CopilotIndexReader] Found index:", {
        identifier: indexIdentifier,
        partitions: metadata.numPartitions,
        vectorLength: metadata.vectorLength,
      });

      // Load all partition files and extract documents + vectors
      for (let i = 0; i < metadata.numPartitions; i++) {
        const chunkPath = `${configDir}/${CHUNK_PREFIX}${indexIdentifier}-${i}.json`;

        if (await this.app.vault.adapter.exists(chunkPath)) {
          console.log("[CopilotIndexReader] Loading partition", i);
          const chunkContent = await this.app.vault.adapter.read(chunkPath);
          const chunkData = JSON.parse(chunkContent);

          // Extract documents and their embeddings directly
          const docs = chunkData.docs?.docs || {};
          for (const [, doc] of Object.entries(docs)) {
            const d = doc as any;
            if (d.id && d.path) {
              this.documents.set(d.id, {
                id: d.id,
                path: d.path,
                title: d.title || d.path.split("/").pop()?.replace(".md", "") || "",
                content: d.content || "",
                mtime: d.mtime || 0,
              });

              // Embedding is stored directly in each document
              if (Array.isArray(d.embedding) && d.embedding.length > 0) {
                this.vectors.set(d.id, d.embedding);
              }
            }
          }
        }
      }

      this.initialized = true;
      console.log(
        "[CopilotIndexReader] Loaded",
        this.documents.size,
        "documents and",
        this.vectors.size,
        "vectors"
      );
      return true;
    } catch (error) {
      console.error("[CopilotIndexReader] Failed to load index:", error);
      return false;
    }
  }

  /**
   * Search for similar notes using vector similarity
   */
  async searchByEmbedding(
    queryEmbedding: number[],
    options: SearchOptions = {}
  ): Promise<RelevantNote[]> {
    if (!this.initialized) {
      console.warn("[CopilotIndexReader] Not initialized");
      return [];
    }

    const { minSimilarity = 0.4, limit = 10, excludePath } = options;

    // Calculate similarity for all vectors
    const results: Array<{ docId: string; similarity: number }> = [];

    for (const [docId, vector] of this.vectors.entries()) {
      const similarity = cosineSimilarity(queryEmbedding, vector);
      if (similarity >= minSimilarity) {
        results.push({ docId, similarity });
      }
    }

    // Sort by similarity (descending)
    results.sort((a, b) => b.similarity - a.similarity);

    // Deduplicate by path (keep highest scoring chunk per note)
    const byPath = new Map<string, RelevantNote>();

    for (const { docId, similarity } of results) {
      const doc = this.documents.get(docId);
      if (!doc) continue;

      // Skip excluded path
      if (excludePath && doc.path === excludePath) continue;

      const existing = byPath.get(doc.path);
      if (!existing || similarity > existing.similarity) {
        byPath.set(doc.path, {
          path: doc.path,
          title: doc.title,
          content: doc.content?.slice(0, 500) || "",
          similarity,
        });
      }
    }

    // Return top results
    return Array.from(byPath.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Get the embedding for a specific file path (to use as query)
   */
  async getEmbeddingForPath(path: string): Promise<number[] | null> {
    if (!this.initialized) return null;

    // Find document with this path and return its embedding
    for (const [docId, doc] of this.documents.entries()) {
      if (doc.path === path) {
        return this.vectors.get(docId) || null;
      }
    }

    return null;
  }

  /**
   * Search for similar notes to a given file path
   */
  async searchSimilarToPath(
    path: string,
    options: SearchOptions = {}
  ): Promise<RelevantNote[]> {
    if (!this.initialized) return [];

    const embedding = await this.getEmbeddingForPath(path);
    if (!embedding) {
      console.warn("[CopilotIndexReader] No embedding found for:", path);
      return [];
    }

    return this.searchByEmbedding(embedding, { ...options, excludePath: path });
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reload the index
   */
  async reload(): Promise<boolean> {
    this.initialized = false;
    this.documents.clear();
    this.vectors.clear();
    return this.initialize();
  }
}
