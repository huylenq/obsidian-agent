import type { RelevantNote } from "../types";

export interface SearchOptions {
  minSimilarity?: number;
  limit?: number;
  excludePath?: string;
}

export interface PairwiseEdge {
  source: string;
  target: string;
  similarity: number;
}

export interface PairwiseResult {
  edges: PairwiseEdge[];
  indexedPaths: string[];
}

export interface IIndexClient {
  initialize(): Promise<boolean>;
  isInitialized(): boolean;
  searchSimilarToPath(
    path: string,
    options?: SearchOptions
  ): Promise<RelevantNote[]>;
  getPairwiseSimilarities(
    paths: string[],
    threshold: number
  ): Promise<PairwiseResult>;
  reload(): Promise<boolean>;
}
