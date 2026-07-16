import { requestUrl } from "obsidian";
import type { RelevantNote } from "../types";
import type { IIndexClient, SearchOptions, PairwiseResult } from "./IIndexClient";

export interface IndexStatus {
  ready: boolean;
  available: boolean;
  docCount: number;
  indexing: boolean;
  progress: { indexed: number; total: number } | null;
  lastBuiltAt: number | null;
}

export class AgentIndexClient implements IIndexClient {
  private ready = false;

  constructor(
    private bridgeUrl: string,
    private authToken?: string
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) h["Authorization"] = `Bearer ${this.authToken}`;
    return h;
  }

  async initialize(): Promise<boolean> {
    try {
      const res = await requestUrl({
        url: `${this.bridgeUrl}/index/status`,
        headers: this.headers(),
      });
      this.ready = res.json.available === true;
      return this.ready;
    } catch {
      this.ready = false;
      return false;
    }
  }

  isInitialized(): boolean {
    return this.ready;
  }

  async getStatus(): Promise<IndexStatus | null> {
    try {
      const res = await requestUrl({
        url: `${this.bridgeUrl}/index/status`,
        headers: this.headers(),
      });
      return res.json as IndexStatus;
    } catch {
      return null;
    }
  }

  async searchSimilarToPath(
    path: string,
    options: SearchOptions = {}
  ): Promise<RelevantNote[]> {
    if (!this.ready) return [];

    try {
      const res = await requestUrl({
        url: `${this.bridgeUrl}/index/search-by-path`,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          path,
          excludePath: options.excludePath || path,
          limit: options.limit || 10,
          minSimilarity: options.minSimilarity || 0.4,
        }),
      });
      return res.json.results || [];
    } catch {
      return [];
    }
  }

  async getPairwiseSimilarities(
    paths: string[],
    threshold: number
  ): Promise<PairwiseResult> {
    if (!this.ready) return { edges: [], indexedPaths: [] };

    try {
      const res = await requestUrl({
        url: `${this.bridgeUrl}/index/pairwise`,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ paths, threshold }),
      });
      return {
        edges: res.json.edges || [],
        indexedPaths: res.json.indexedPaths || [],
      };
    } catch {
      return { edges: [], indexedPaths: [] };
    }
  }

  // Uses fetch instead of Obsidian's requestUrl: POST through requestUrl to
  // localhost fails with net::ERR_FAILED — Electron's net.request does a
  // Private Network Access preflight that Express's stock cors() doesn't
  // answer. Renderer fetch is fine because the server has cors().
  async reload(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
      const res = await fetch(`${this.bridgeUrl}/index/rebuild`, {
        method: "POST",
        headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
