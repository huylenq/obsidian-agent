import { ClaudeAgentSettings, ActiveFileContext, SelectionContext } from "@/types";
import { FileSearchResult } from "@/utils/fileSearch";

const PROXY_URL = "http://localhost:27182";

export interface ChatResponse {
  type: "text" | "tool_call" | "tool_result" | "error" | "done" | "session";
  content: string;
  toolName?: string;
  sessionId?: string;
}

/**
 * ClaudeAgentClient communicates with the local proxy server
 */
export class ClaudeAgentClient {
  private settings: ClaudeAgentSettings;
  private vaultPath: string;
  private onSessionChange: ((sessionId: string | null) => void) | null = null;

  constructor(settings: ClaudeAgentSettings, vaultPath: string) {
    this.settings = settings;
    this.vaultPath = vaultPath;
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
    // Check if proxy server is running
    try {
      const response = await fetch(`${PROXY_URL}/health`);
      if (!response.ok) {
        throw new Error("Proxy server health check failed");
      }
      console.log("[ClaudeAgentClient] Proxy server is running");
    } catch (error) {
      throw new Error(
        `Claude Agent proxy server is not running. Please start it with:\n` +
        `cd server && npm start\n\n` +
        `Original error: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  /**
   * Send a message and stream the response
   */
  async *chat(
    message: string,
    activeFile?: ActiveFileContext,
    mentionedFiles?: FileSearchResult[],
    selection?: SelectionContext
  ): AsyncGenerator<ChatResponse> {
    try {
      console.log("[ClaudeAgentClient] Sending chat with workingDirectory:", this.vaultPath, "activeFile:", activeFile?.path, "mentionedFiles:", mentionedFiles?.length || 0, "selection:", selection?.text?.slice(0, 50) || "none");

      // Retry logic for transient connection issues
      let response: Response | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await fetch(`${PROXY_URL}/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message,
              systemPrompt: this.settings.systemPrompt,
              sessionId: this.settings.sessionId || undefined,
              workingDirectory: this.vaultPath,
              activeFile,
              mentionedFiles,
              selection,
              model: this.settings.model,
            }),
          });
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

      // Parse SSE stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

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
              yield this.parseProxyMessage(data);
            } catch (e) {
              // Ignore parse errors for incomplete data
            }
          }
        }
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
  private parseProxyMessage(data: { type: string; content?: string; toolName?: string; sessionId?: string }): ChatResponse {
    switch (data.type) {
      case "text":
        return { type: "text", content: data.content || "" };
      case "tool_call":
        return { type: "tool_call", content: `Executing: ${data.toolName}`, toolName: data.toolName };
      case "tool_result":
        return { type: "tool_result", content: `Result from: ${data.toolName}`, toolName: data.toolName };
      case "error":
        return { type: "error", content: data.content || "Unknown error" };
      case "session":
        // Store session ID for conversation continuity
        if (data.sessionId) {
          this.settings.sessionId = data.sessionId;
          this.onSessionChange?.(data.sessionId);
          console.log("[ClaudeAgentClient] Session ID:", data.sessionId);
        }
        return { type: "session", content: "", sessionId: data.sessionId };
      case "done":
        // Also capture session ID from done event if present
        if (data.sessionId && !this.settings.sessionId) {
          this.settings.sessionId = data.sessionId;
          this.onSessionChange?.(data.sessionId);
        }
        return { type: "done", content: "", sessionId: data.sessionId };
      default:
        return { type: "text", content: "" };
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
  async fetchHistory(): Promise<Array<{ role: "user" | "assistant"; content: string; timestamp: number }>> {
    const sessionId = this.settings.sessionId;
    if (!sessionId) {
      return [];
    }

    try {
      console.log("[ClaudeAgentClient] Fetching history for session:", sessionId);

      const response = await fetch(`${PROXY_URL}/history`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
