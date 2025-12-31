/**
 * Search ranking and categorization for relevant notes
 */

import type { App, CachedMetadata } from "obsidian";
import type { RelevantNote, RankedNote, SimilarityCategory } from "../types";

// Similarity thresholds
const HIGH_THRESHOLD = 0.7;
const MEDIUM_THRESHOLD = 0.55;

// Weighting factors
const SIMILARITY_WEIGHT = 0.7;
const LINK_WEIGHT = 0.3;

/**
 * Categorize a similarity score into high/medium/low
 */
export function categorizeScore(score: number): SimilarityCategory {
  if (score >= HIGH_THRESHOLD) return "high";
  if (score >= MEDIUM_THRESHOLD) return "medium";
  return "low";
}

/**
 * Get outgoing links and backlinks for a file
 */
function getLinks(
  app: App,
  filePath: string
): { outgoing: Set<string>; backlinks: Set<string> } {
  const outgoing = new Set<string>();
  const backlinks = new Set<string>();

  // Get outgoing links from the file's metadata cache
  const fileCache = app.metadataCache.getCache(filePath);
  if (fileCache?.links) {
    for (const link of fileCache.links) {
      const linkedFile = app.metadataCache.getFirstLinkpathDest(
        link.link,
        filePath
      );
      if (linkedFile) {
        outgoing.add(linkedFile.path);
      }
    }
  }

  // Get backlinks (files that link TO this file)
  // @ts-ignore - resolvedLinks is available on metadataCache
  const resolvedLinks = app.metadataCache.resolvedLinks;
  if (resolvedLinks) {
    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links && typeof links === "object" && filePath in links) {
        backlinks.add(sourcePath);
      }
    }
  }

  return { outgoing, backlinks };
}

/**
 * Rank notes by combining similarity score with link structure
 *
 * Formula: finalScore = similarity * 0.7 + linkBonus * 0.3
 * Where linkBonus is:
 * - 1.0 if the note has both outgoing link and backlink
 * - 0.8 if the note has either outgoing link or backlink
 * - 0.0 if no link relationship
 */
export function rankNotes(
  notes: RelevantNote[],
  currentFilePath: string | null,
  app: App
): RankedNote[] {
  // Get link information for current file
  const links = currentFilePath
    ? getLinks(app, currentFilePath)
    : { outgoing: new Set<string>(), backlinks: new Set<string>() };

  return notes
    .map((note) => {
      const hasOutgoingLink = links.outgoing.has(note.path);
      const hasBacklink = links.backlinks.has(note.path);

      // Calculate link bonus
      let linkBonus = 0;
      if (hasOutgoingLink && hasBacklink) {
        linkBonus = 1.0;
      } else if (hasOutgoingLink || hasBacklink) {
        linkBonus = 0.8;
      }

      // Calculate final score
      const finalScore =
        note.similarity * SIMILARITY_WEIGHT + linkBonus * LINK_WEIGHT;

      return {
        ...note,
        finalScore,
        category: categorizeScore(finalScore),
        hasOutgoingLink,
        hasBacklink,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}
