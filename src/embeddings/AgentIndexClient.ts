import { requestUrl } from "obsidian";
import type { RelevantNote } from "../types";
import type { IIndexClient, SearchOptions, PairwiseResult } from "./IIndexClient";

export class AgentIndexClient implements IIndexClient {
  private ready = false;

  constructor(
    private proxyUrl: string,
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
        url: `${this.proxyUrl}/index/status`,
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

  async searchSimilarToPath(
    path: string,
    options: SearchOptions = {}
  ): Promise<RelevantNote[]> {
    if (!this.ready) return [];

    try {
      const res = await requestUrl({
        url: `${this.proxyUrl}/index/search-by-path`,
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
        url: `${this.proxyUrl}/index/pairwise`,
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

  async reload(): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.proxyUrl}/index/rebuild`,
        method: "POST",
        headers: this.headers(),
        body: "{}",
      });
      return true;
    } catch {
      return false;
    }
  }
}
