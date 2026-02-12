import { ClaudeAgentSettings, ActiveFileContext, SelectionContext, RankedNote, SessionEntry, SessionStatus } from "@/types";
import { FileSearchResult } from "@/utils/fileSearch";

export interface ChatResponse {
  type: "text" | "tool_use" | "tool_result" | "error" | "done" | "session" | "compact_boundary" | "result";
  content: string;
  toolName?: string;
  toolUseId?: string;
  description?: string;
  input?: string;
  isError?: boolean;
  sessionId?: string;
  resultMetadata?: {
    durationMs?: number;
    numTurns?: number;
    totalCostUsd?: number;
  };
  compactMetadata?: {
    preTokens: number;
    trigger: "manual" | "auto";
    summary?: string;
  };
}

/**
 * ClaudeAgentClient communicates with the local proxy server
 */
export class ClaudeAgentClient {
  private settings: ClaudeAgentSettings;
  private vaultPath: string;
  private proxyUrl: string;
  private authToken?: string;
  private onSessionChange: ((sessionId: string | null) => void) | null = null;

  constructor(settings: ClaudeAgentSettings, vaultPath: string, proxyUrl: string, authToken?: string) {
    this.settings = settings;
    this.vaultPath = vaultPath;
    this.proxyUrl = proxyUrl;
    this.authToken = authToken;
  }

  /**
   * Build headers with optional auth token
   */
  private getHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      // Skip ngrok's free-tier browser warning interstitial
      "ngrok-skip-browser-warning": "1",
      ...extra,
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  /**
   * Set callback for when session ID changes (for persistence)
   */
  setOnSessionChange(callback: (sessionId: string | null) => void): void {
    this.onSessionChange = callback;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.settings.sessionId;
  }

  /**
   * Clear the session (start fresh conversation)
   */
  clearSession(): void {
    this.settings.sessionId = null;
    this.onSessionChange?.(null);
  }

  /**
   * Initialize the client (check proxy is running)
   */
  async initialize(): Promise<void> {
    try {
      const response = await fetch(`${this.proxyUrl}/health`, { headers: this.getHeaders() });
      if (!response.ok) {
        throw new Error(`Health check returned ${response.status}`);
      }
      console.log("[ClaudeAgentClient] Server reachable at", this.proxyUrl);
    } catch (error) {
      const original = error instanceof Error ? error.message : error;
      const isRemote = !this.proxyUrl.includes("localhost");
      if (isRemote) {
        throw new Error(`Cannot reach remote server at ${this.proxyUrl} — ${original}`);
      }
      throw new Error(`Local proxy server is not running — ${original}`);
    }
  }

  /**
   * Send a message and stream the response
   */
  async *chat(
    message: string,
    activeFile?: ActiveFileContext,
    mentionedFiles?: FileSearchResult[],
    selection?: SelectionContext,
    relevantNotes?: RankedNote[]
  ): AsyncGenerator<ChatResponse> {
    try {
      console.log("[ClaudeAgentClient] Sending chat with workingDirectory:", this.vaultPath, "activeFile:", activeFile?.path, "mentionedFiles:", mentionedFiles?.length || 0, "selection:", selection?.text?.slice(0, 50) || "none", "relevantNotes:", relevantNotes?.length || 0);

      // Retry logic for transient connection issues
      let response: Response | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await fetch(`${this.proxyUrl}/chat`, {
            method: "POST",
            headers: this.getHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              message,
              systemPrompt: this.settings.systemPrompt,
              sessionId: this.settings.sessionId || undefined,
              workingDirectory: this.vaultPath,
              activeFile,
              mentionedFiles,
              selection,
              model: this.settings.model,
              relevantNotes,
            }),
          });
          // Fail fast on auth errors
          if (response.status === 401) {
            throw new Error("Authentication failed — check your auth token in settings");
          }
          break; // Success, exit retry loop
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          console.warn(`[ClaudeAgentClient] Fetch attempt ${attempt} failed:`, lastError.message);
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          }
        }
      }

      if (!response) {
        throw lastError || new Error("Failed to connect to proxy server");
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Proxy request failed: ${error}`);
      }

      // Check content type — if not event-stream, the response is likely
      // an ngrok interstitial page or proxy error HTML
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const body = await response.text();
        const preview = body.slice(0, 200).replace(/\s+/g, " ");
        throw new Error(`Expected SSE stream but got ${contentType || "unknown content-type"}: ${preview}`);
      }

      // Parse SSE stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let yieldedAny = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              yieldedAny = true;
              yield this.parseProxyMessage(data);
            } catch (e) {
              console.warn("[ClaudeAgentClient] Failed to parse SSE line:", line.slice(0, 200));
            }
          }
        }
      }

      if (!yieldedAny) {
        throw new Error("Server returned empty response — no SSE events received");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      yield { type: "error", content: errorMessage };
    }
  }

  /**
   * Parse proxy server message into ChatResponse
   */
  private parseProxyMessage(data: Record<string, unknown>): ChatResponse {
    switch (data.type) {
      case "text":
        return { type: "text", content: (data.content as string) || "" };
      case "tool_use":
        return {
          type: "tool_use",
          content: "",
          toolName: data.toolName as string,
          toolUseId: data.toolUseId as string,
          description: data.description as string,
          input: data.input as string,
        };
      case "tool_result":
        return {
          type: "tool_result",
          content: (data.content as string) || "",
          toolUseId: data.toolUseId as string,
          isError: data.isError as boolean,
        };
      case "result":
        return {
          type: "result",
          content: "",
          resultMetadata: {
            durationMs: data.durationMs as number,
            numTurns: data.numTurns as number,
            totalCostUsd: data.totalCostUsd as number,
          },
        };
      case "error":
        return { type: "error", content: (data.content as string) || "Unknown error" };
      case "compact_boundary":
        return {
          type: "compact_boundary",
          content: "",
          compactMetadata: {
            preTokens: (data.preTokens as number) || 0,
            trigger: ((data.trigger as string) || "manual") as "manual" | "auto",
            summary: data.summary as string,
          },
        };
      case "session":
        // Store session ID for conversation continuity
        if (data.sessionId) {
          this.settings.sessionId = data.sessionId as string;
          this.onSessionChange?.(data.sessionId as string);
          console.log("[ClaudeAgentClient] Session ID:", data.sessionId);
        }
        return { type: "session", content: "", sessionId: data.sessionId as string };
      case "done":
        // Also capture session ID from done event if present
        if (data.sessionId && !this.settings.sessionId) {
          this.settings.sessionId = data.sessionId as string;
          this.onSessionChange?.(data.sessionId as string);
        }
        return { type: "done", content: "", sessionId: data.sessionId as string };
      default:
        return { type: "text", content: "" };
    }
  }

  /**
   * Switch to an existing session
   */
  switchSession(sessionId: string): void {
    this.settings.sessionId = sessionId;
    this.onSessionChange?.(sessionId);
  }

  /**
   * Fetch sessions from registry
   */
  async fetchSessions(filters?: { status?: SessionStatus | "all"; file?: string }): Promise<SessionEntry[]> {
    try {
      const params = new URLSearchParams({ workingDirectory: this.vaultPath });
      if (filters?.status) params.set("status", filters.status);
      if (filters?.file) params.set("file", filters.file);

      const response = await fetch(`${this.proxyUrl}/sessions?${params}`, { headers: this.getHeaders() });
      if (!response.ok) return [];

      const data = await response.json();
      return data.sessions || [];
    } catch (error) {
      console.warn("[ClaudeAgentClient] Error fetching sessions:", error);
      return [];
    }
  }

  /**
   * Update a session's status or title
   */
  async updateSession(sessionId: string, updates: { status?: SessionStatus; title?: string }): Promise<SessionEntry | null> {
    try {
      const response = await fetch(`${this.proxyUrl}/sessions/${sessionId}`, {
        method: "PATCH",
        headers: this.getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ workingDirectory: this.vaultPath, ...updates }),
      });
      if (!response.ok) return null;

      const data = await response.json();
      return data.session || null;
    } catch (error) {
      console.warn("[ClaudeAgentClient] Error updating session:", error);
      return null;
    }
  }

  /**
   * Trigger one-time migration of JSONL files to registry
   */
  async migrateSessionRegistry(): Promise<number> {
    try {
      const response = await fetch(`${this.proxyUrl}/sessions/migrate`, {
        method: "POST",
        headers: this.getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ workingDirectory: this.vaultPath }),
      });
      if (!response.ok) return 0;

      const data = await response.json();
      console.log("[ClaudeAgentClient] Migration result:", data.migrated, "sessions");
      return data.migrated || 0;
    } catch (error) {
      console.warn("[ClaudeAgentClient] Migration error:", error);
      return 0;
    }
  }

  /**
   * Update settings
   */
  updateSettings(settings: ClaudeAgentSettings): void {
    this.settings = settings;
  }

  /**
   * Fetch session history from transcript file
   * Returns array of messages or empty array if no history
   */
  async fetchHistory(): Promise<Array<Record<string, unknown>>> {
    const sessionId = this.settings.sessionId;
    if (!sessionId) {
      return [];
    }

    try {
      console.log("[ClaudeAgentClient] Fetching history for session:", sessionId);

      const response = await fetch(`${this.proxyUrl}/history`, {
        method: "POST",
        headers: this.getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          sessionId,
          workingDirectory: this.vaultPath,
        }),
      });

      if (!response.ok) {
        console.warn("[ClaudeAgentClient] Failed to fetch history:", response.status);
        return [];
      }

      const data = await response.json();
      console.log("[ClaudeAgentClient] Fetched", data.messages?.length || 0, "history messages");
      return data.messages || [];
    } catch (error) {
      console.warn("[ClaudeAgentClient] Error fetching history:", error);
      return [];
    }
  }
}
