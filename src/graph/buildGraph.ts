/**
 * Build a semantic graph combining wiki-link BFS traversal with embedding similarity.
 */

import type { App } from "obsidian";
import type { IIndexClient } from "@/embeddings";
import type { GraphNode, GraphEdge, GraphData, GraphViewSettings, PinnedNodeConfig } from "@/types";

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
  indexClient: IIndexClient,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  settings: GraphViewSettings,
): Promise<void> {
  const similarNotes = await indexClient.searchSimilarToPath(centerPath, {
    minSimilarity: settings.similarityThreshold,
    limit: settings.maxSimilarityEdges,
  });

  // If we got results, the center path is in the index
  const centerNode = nodes.get(centerPath);
  if (centerNode) centerNode.inVectorIndex = similarNotes.length > 0;

  for (const note of similarNotes) {
    if (nodes.has(note.path)) {
      nodes.get(note.path)!.inVectorIndex = true;
    } else if (nodes.size < MAX_NODES) {
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
}

/**
 * Phase 1b: BFS from each pinned node using its local or global linkDepth.
 */
function bfsPinnedNodes(
  app: App,
  pins: PinnedNodeConfig[],
  nodes: Map<string, GraphNode>,
  globalDepth: number,
): void {
  for (const pin of pins) {
    const maxDepth = pin.linkDepth ?? globalDepth;

    // Seed pinned origin if not already present
    if (!nodes.has(pin.path)) {
      if (nodes.size >= MAX_NODES) continue;
      nodes.set(pin.path, {
        id: pin.path,
        title: titleFromPath(pin.path),
        depth: 0,
        isCenter: false,
        isPinned: true,
        pinnedConfig: pin,
        inVectorIndex: false,
      });
    } else {
      const existing = nodes.get(pin.path)!;
      existing.isPinned = true;
      existing.pinnedConfig = pin;
    }

    // BFS from pin
    const queue: [string, number][] = [[pin.path, 0]];
    const visited = new Set<string>([pin.path]);

    while (queue.length > 0) {
      const [currentPath, currentDepth] = queue.shift()!;
      if (currentDepth >= maxDepth) continue;

      const nextDepth = currentDepth + 1;

      for (const targetPath of getOutgoingLinks(app, currentPath)) {
        if (!visited.has(targetPath)) {
          visited.add(targetPath);
          if (!nodes.has(targetPath)) {
            if (nodes.size >= MAX_NODES) break;
            nodes.set(targetPath, {
              id: targetPath,
              title: titleFromPath(targetPath),
              depth: nextDepth,
              isCenter: false,
              inVectorIndex: false,
            });
          }
          if (nextDepth < maxDepth) {
            queue.push([targetPath, nextDepth]);
          }
        }
        if (nodes.size >= MAX_NODES) break;
      }
      if (nodes.size >= MAX_NODES) break;
    }
  }
}

/**
 * Phase 2b: Similarity edges from each pinned node using local or global threshold.
 */
async function discoverPinnedSimilarity(
  pins: PinnedNodeConfig[],
  indexClient: IIndexClient,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  settings: GraphViewSettings,
): Promise<void> {
  for (const pin of pins) {
    const threshold = pin.similarityThreshold ?? settings.similarityThreshold;

    const similarNotes = await indexClient.searchSimilarToPath(pin.path, {
      minSimilarity: threshold,
      limit: settings.maxSimilarityEdges,
    });

    const pinNode = nodes.get(pin.path);
    if (pinNode) pinNode.inVectorIndex = similarNotes.length > 0;

    for (const note of similarNotes) {
      if (nodes.has(note.path)) {
        nodes.get(note.path)!.inVectorIndex = true;
      } else if (nodes.size < MAX_NODES) {
        nodes.set(note.path, {
          id: note.path,
          title: note.title || titleFromPath(note.path),
          depth: (pin.linkDepth ?? settings.linkDepth) + 1,
          isCenter: false,
          inVectorIndex: true,
        });
      }

      const key = simEdgeKey(pin.path, note.path);
      if (!edges.has(key)) {
        edges.set(key, {
          id: key,
          source: pin.path,
          target: note.path,
          type: "similarity",
          direction: "outgoing",
          weight: note.similarity,
        });
      }
    }
  }
}

/**
 * Phase 4: Discover pairwise similarity edges between ALL visible nodes.
 * Delegates to server which computes O(n²) cosine on stored vectors.
 */
async function discoverPairwiseSimilarity(
  indexClient: IIndexClient,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  threshold: number,
): Promise<void> {
  const paths = Array.from(nodes.keys());
  const { edges: pairEdges, indexedPaths } = await indexClient.getPairwiseSimilarities(paths, threshold);

  // Mark which nodes are in the vector index
  for (const p of indexedPaths) {
    const node = nodes.get(p);
    if (node) node.inVectorIndex = true;
  }

  // Add edges
  for (const { source, target, similarity } of pairEdges) {
    const key = simEdgeKey(source, target);
    if (edges.has(key)) continue;
    if (!nodes.has(source) || !nodes.has(target)) continue;

    edges.set(key, {
      id: key,
      source,
      target,
      type: "similarity",
      direction: "outgoing",
      weight: similarity,
    });
  }
}

export async function buildGraph(
  centerPath: string,
  app: App,
  indexClient: IIndexClient | null,
  settings: GraphViewSettings,
): Promise<GraphData> {
  // Phase 1: BFS to collect nodes from center
  const { nodes, edges } = bfsLinks(app, centerPath, settings.linkDepth);

  // Phase 1b: BFS from pinned nodes (adds nodes using per-pin or global depth)
  const allPins = settings.pinnedNodes ?? [];
  const pins = allPins.filter((p) => p.path !== centerPath);
  if (pins.length > 0) {
    bfsPinnedNodes(app, pins, nodes, settings.linkDepth);
  }

  // Mark center as pinned if it's in the pin list (gets both isCenter + isPinned)
  const centerPin = allPins.find((p) => p.path === centerPath);
  if (centerPin) {
    const centerNode = nodes.get(centerPath);
    if (centerNode) {
      centerNode.isPinned = true;
      centerNode.pinnedConfig = centerPin;
    }
  }

  // Phase 2: Similarity edges from center (may add new periphery nodes)
  if (indexClient?.isInitialized() && settings.showSimilarityEdges) {
    await discoverCenterSimilarity(centerPath, indexClient, nodes, edges, settings);
  }

  // Phase 2b: Similarity edges from pinned nodes
  if (indexClient?.isInitialized() && settings.showSimilarityEdges && pins.length > 0) {
    await discoverPinnedSimilarity(pins, indexClient, nodes, edges, settings);
  }

  // Phase 3: Link edges between ALL visible nodes
  if (settings.showLinkEdges) {
    discoverLinkEdges(app, nodes, edges);
  }

  // Phase 4: Pairwise similarity edges between ALL visible nodes
  if (indexClient?.isInitialized() && settings.showSimilarityEdges) {
    await discoverPairwiseSimilarity(indexClient, nodes, edges, settings.similarityThreshold);
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    centerPath,
  };
}
