/**
 * Build a semantic graph combining wiki-link BFS traversal with embedding similarity.
 */

import type { App } from "obsidian";
import type { CopilotIndexReader } from "@/embeddings";
import type { GraphNode, GraphEdge, GraphData, GraphViewSettings } from "@/types";

const MAX_NODES = 200;

/**
 * Get outgoing wiki-links from a file's metadata cache.
 * Returns resolved vault-relative paths.
 */
function getOutgoingLinks(app: App, filePath: string): string[] {
  const cache = app.metadataCache.getCache(filePath);
  if (!cache?.links) return [];

  const paths: string[] = [];
  for (const link of cache.links) {
    const dest = app.metadataCache.getFirstLinkpathDest(link.link, filePath);
    if (dest) paths.push(dest.path);
  }
  return paths;
}

/**
 * Get file title from path (filename without extension).
 */
function titleFromPath(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename.replace(/\.md$/, "");
}

function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * Canonical edge key — always alphabetically sorted so A--B and B--A map to the same key.
 */
function linkEdgeKey(a: string, b: string): string {
  return a < b ? `${a}--link--${b}` : `${b}--link--${a}`;
}

function simEdgeKey(a: string, b: string): string {
  return a < b ? `${a}--similarity--${b}` : `${b}--similarity--${a}`;
}

/**
 * Phase 1: BFS over wiki-links up to `maxDepth` levels.
 */
function bfsLinks(
  app: App,
  centerPath: string,
  maxDepth: number,
): { nodes: Map<string, GraphNode>; edges: Map<string, GraphEdge> } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  // Seed with center node
  nodes.set(centerPath, {
    id: centerPath,
    title: titleFromPath(centerPath),
    depth: 0,
    isCenter: true,
    inVectorIndex: false,
  });

  // BFS queue: [path, depth]
  const queue: [string, number][] = [[centerPath, 0]];
  const visited = new Set<string>([centerPath]);

  while (queue.length > 0) {
    const [currentPath, currentDepth] = queue.shift()!;
    if (currentDepth >= maxDepth) continue;

    const nextDepth = currentDepth + 1;

    for (const targetPath of getOutgoingLinks(app, currentPath)) {
      // Add node if not visited
      if (!visited.has(targetPath)) {
        visited.add(targetPath);
        nodes.set(targetPath, {
          id: targetPath,
          title: titleFromPath(targetPath),
          depth: nextDepth,
          isCenter: false,
          inVectorIndex: false,
        });
        if (nextDepth < maxDepth) {
          queue.push([targetPath, nextDepth]);
        }
      }

      // Cap nodes to prevent runaway at depth 3
      if (nodes.size >= MAX_NODES) break;
    }
    if (nodes.size >= MAX_NODES) break;
  }

  return { nodes, edges };
}

/**
 * Phase 2: Discover ALL link edges between visible nodes.
 * Checks outgoing links for every node and adds an edge if the target is also visible.
 */
function discoverLinkEdges(
  app: App,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): void {
  for (const sourcePath of nodes.keys()) {
    for (const targetPath of getOutgoingLinks(app, sourcePath)) {
      if (!nodes.has(targetPath)) continue;

      const key = linkEdgeKey(sourcePath, targetPath);
      const existing = edges.get(key);

      if (existing) {
        // If we already recorded the reverse direction, upgrade to bidirectional
        const existingSource = typeof existing.source === "string" ? existing.source : existing.source.id;
        if (existingSource !== sourcePath) {
          existing.direction = "bidirectional";
        }
      } else {
        edges.set(key, {
          id: key,
          source: sourcePath,
          target: targetPath,
          type: "link",
          direction: "outgoing",
          weight: 1.0,
        });
      }
    }
  }
}

/**
 * Phase 3: Add similarity edges from center to similar notes (may add new nodes).
 */
async function discoverCenterSimilarity(
  centerPath: string,
  indexReader: CopilotIndexReader,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  settings: GraphViewSettings,
): Promise<void> {
  const similarNotes = await indexReader.searchSimilarToPath(centerPath, {
    minSimilarity: settings.similarityThreshold,
    limit: settings.maxSimilarityEdges,
  });

  for (const note of similarNotes) {
    if (nodes.has(note.path)) {
      nodes.get(note.path)!.inVectorIndex = true;
    } else if (nodes.size < MAX_NODES) {
      // Similarity-only node at periphery
      nodes.set(note.path, {
        id: note.path,
        title: note.title || titleFromPath(note.path),
        depth: settings.linkDepth + 1,
        isCenter: false,
        inVectorIndex: true,
      });
    }

    const key = simEdgeKey(centerPath, note.path);
    if (!edges.has(key)) {
      edges.set(key, {
        id: key,
        source: centerPath,
        target: note.path,
        type: "similarity",
        direction: "outgoing",
        weight: note.similarity,
      });
    }
  }

  // Mark center node
  const centerNode = nodes.get(centerPath);
  if (centerNode) {
    const embedding = await indexReader.getEmbeddingForPath(centerPath);
    centerNode.inVectorIndex = embedding !== null;
  }
}

/**
 * Phase 4: Discover pairwise similarity edges between ALL visible nodes.
 * Fetches embeddings for every visible node and computes cosine similarity for each pair.
 */
async function discoverPairwiseSimilarity(
  indexReader: CopilotIndexReader,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  threshold: number,
): Promise<void> {
  // Gather embeddings for all visible nodes
  const embeddings = new Map<string, number[]>();
  for (const path of nodes.keys()) {
    const emb = await indexReader.getEmbeddingForPath(path);
    if (emb) {
      embeddings.set(path, emb);
      nodes.get(path)!.inVectorIndex = true;
    }
  }

  // Pairwise comparison
  const paths = Array.from(embeddings.keys());
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const key = simEdgeKey(paths[i], paths[j]);
      if (edges.has(key)) continue; // already have this edge (e.g. from center similarity)

      const sim = cosineSimilarity(embeddings.get(paths[i])!, embeddings.get(paths[j])!);
      if (sim >= threshold) {
        edges.set(key, {
          id: key,
          source: paths[i],
          target: paths[j],
          type: "similarity",
          direction: "outgoing",
          weight: sim,
        });
      }
    }
  }
}

export async function buildGraph(
  centerPath: string,
  app: App,
  indexReader: CopilotIndexReader | null,
  settings: GraphViewSettings,
): Promise<GraphData> {
  // Phase 1: BFS to collect nodes
  const { nodes, edges } = bfsLinks(app, centerPath, settings.linkDepth);

  // Phase 2: Similarity edges from center (may add new periphery nodes)
  if (indexReader?.isInitialized() && settings.showSimilarityEdges) {
    await discoverCenterSimilarity(centerPath, indexReader, nodes, edges, settings);
  }

  // Phase 3: Link edges between ALL visible nodes
  if (settings.showLinkEdges) {
    discoverLinkEdges(app, nodes, edges);
  }

  // Phase 4: Pairwise similarity edges between ALL visible nodes
  if (indexReader?.isInitialized() && settings.showSimilarityEdges) {
    await discoverPairwiseSimilarity(indexReader, nodes, edges, settings.similarityThreshold);
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    centerPath,
  };
}
