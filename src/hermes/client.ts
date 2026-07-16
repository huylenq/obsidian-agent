import { HermesAgentSettings, ActiveFileContext, SelectionContext, RankedNote, SessionEntry, SessionStatus, SessionType, ImageAttachment, HermesModel, HermesSessionModelResponse } from "@/types";
import { FileSearchResult } from "@/utils/fileSearch";

export interface ChatResponse {
  type: "text" | "tool_use" | "tool_result" | "error" | "done" | "session" | "compact_boundary" | "result" | "interrupted";
  content: string;
  toolName?: string;
  toolUseId?: string;
  description?: string;
  input?: string;
  isError?: boolean;
  // Vault-aware structured fields for Read/Write/Edit (set by the bridge)
  filePath?: string;
  editOld?: string;
  editNew?: string;
  writeContent?: string;
  writeLinks?: readonly string[];
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

interface PendingBridgeRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

/**
 * HermesAgentClient uses the Hermes WebSocket bridge for chat and its HTTP
 * service endpoints for index, history, and session metadata.
 */
export class HermesAgentClient {
  private settings: HermesAgentSettings;
  private vaultPath: string;
  readonly bridgeUrl: string;
  readonly authToken?: string;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextRequestId = 0;
  private pendingRequests = new Map<number, PendingBridgeRequest>();
  private chatQueues = new Map<string, AsyncEventQueue<ChatResponse>>();
  private activeChatId: string | null = null;
  private onSessionChange: ((sessionId: string | null) => void) | null = null;

  constructor(settings: HermesAgentSettings, vaultPath: string, bridgeUrl: string, authToken?: string) {
    this.settings = settings;
    this.vaultPath = vaultPath;
    this.bridgeUrl = bridgeUrl;
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

  /** Resolve the effective ACP provider/model and available session choices. */
  async getModelState(): Promise<HermesSessionModelResponse> {
    const result = await this.requestBridge("session/models", {
      sessionId: this.settings.sessionId || undefined,
    }) as HermesSessionModelResponse;
    if (result.sessionId && result.sessionId !== this.settings.sessionId) {
      this.settings.sessionId = result.sessionId;
      this.onSessionChange?.(result.sessionId);
    }
    if (result.models?.currentModelId) {
      this.settings.model = result.models.currentModelId;
    }
    return result;
  }

  /** Switch the active ACP session to a concrete provider/model choice. */
  async setModel(modelId: HermesModel): Promise<HermesSessionModelResponse> {
    if (!this.settings.sessionId) await this.getModelState();
    const sessionId = this.settings.sessionId;
    if (!sessionId) throw new Error("Hermes ACP session is not ready");
    const result = await this.requestBridge("session/set-model", {
      sessionId,
      modelId,
    }) as HermesSessionModelResponse;
    this.settings.model = result.models?.currentModelId || modelId;
    return result;
  }

  async initialize(): Promise<void> {
    try {
      const response = await fetch(`${this.bridgeUrl}/health`, { headers: this.getHeaders() });
      if (!response.ok) throw new Error(`Health check returned ${response.status}`);
      await this.ensureBridge();
      console.log("[HermesAgentClient] Hermes bridge reachable at", this.bridgeUrl);
    } catch (error) {
      const original = error instanceof Error ? error.message : error;
      const isRemote = !this.bridgeUrl.includes("localhost");
      if (isRemote) {
        throw new Error(`Cannot reach remote Hermes bridge at ${this.bridgeUrl} — ${original}`);
      }
      throw new Error(`Local Hermes bridge is not running — ${original}`);
    }
  }

  private getWebSocketUrl(): string {
    const url = new URL(this.bridgeUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/bridge`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  private async ensureBridge(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.getWebSocketUrl());
      let settled = false;

      socket.onmessage = (event) => this.handleBridgeMessage(event.data);
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        const error = new Error("Hermes bridge connection closed");
        this.rejectPendingRequests(error);
        for (const queue of this.chatQueues.values()) queue.fail(error);
        this.chatQueues.clear();
        this.activeChatId = null;
        if (!settled) reject(error);
      };
      socket.onerror = () => {
        if (!settled) reject(new Error("Failed to connect to Hermes bridge"));
      };
      socket.onopen = () => {
        this.socket = socket;
        this.sendBridgeRequest("bridge/authenticate", {
          authToken: this.authToken || undefined,
        }, 10_000).then(() => {
          settled = true;
          resolve();
        }).catch((error) => {
          settled = true;
          socket.close();
          reject(error);
        });
      };
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private handleBridgeMessage(raw: unknown): void {
    let message: Record<string, any>;
    try {
      message = JSON.parse(String(raw));
    } catch {
      console.warn("[HermesAgentClient] Ignoring invalid bridge message");
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Bridge request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "chat/event") {
      const chatId = message.params?.chatId as string;
      const event = this.parseBridgeEvent(message.params?.event || {});
      const queue = this.chatQueues.get(chatId);
      if (!queue) return;
      queue.push(event);
      if (event.type === "done") {
        queue.close();
        this.chatQueues.delete(chatId);
        if (this.activeChatId === chatId) this.activeChatId = null;
      }
    }
  }

  private async requestBridge(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    await this.ensureBridge();
    return this.sendBridgeRequest(method, params, timeoutMs);
  }

  private sendBridgeRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Hermes bridge is not connected"));
    }
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /** Send a message and stream bridge events. */
  async *chat(
    message: string,
    activeFile?: ActiveFileContext,
    mentionedFiles?: FileSearchResult[],
    selection?: SelectionContext,
    relevantNotes?: RankedNote[],
    flashcardMeta?: { cardId: string; sourceFile: string; question: string },
    sessionMeta?: { type: SessionType; epoch: string },
    images?: ImageAttachment[],
  ): AsyncGenerator<ChatResponse> {
    const chatId = crypto.randomUUID();
    const queue = new AsyncEventQueue<ChatResponse>();
    this.chatQueues.set(chatId, queue);
    this.activeChatId = chatId;

    try {
      console.log("[HermesAgentClient] Starting bridge chat for", this.vaultPath);
      await this.requestBridge("chat/start", {
        chatId,
        request: {
          message,
          systemPrompt: this.settings.systemPrompt,
          sessionId: this.settings.sessionId || undefined,
          activeFile,
          mentionedFiles,
          selection,
          model: this.settings.model,
          relevantNotes,
          ...(flashcardMeta && { flashcardMeta }),
          ...(sessionMeta && { sessionMeta }),
          ...(images?.length && { images }),
        },
      });

      for await (const event of queue) yield event;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      yield { type: "error", content: errorMessage };
    } finally {
      queue.close();
      this.chatQueues.delete(chatId);
      if (this.activeChatId === chatId) this.activeChatId = null;
    }
  }

  private parseBridgeEvent(data: Record<string, unknown>): ChatResponse {
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
          filePath: data.filePath as string | undefined,
          editOld: data.editOld as string | undefined,
          editNew: data.editNew as string | undefined,
          writeContent: data.writeContent as string | undefined,
          writeLinks: data.writeLinks as readonly string[] | undefined,
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
      case "interrupted":
        return { type: "interrupted", content: "" };
      case "session":
        // Store session ID for conversation continuity
        if (data.sessionId) {
          this.settings.sessionId = data.sessionId as string;
          this.onSessionChange?.(data.sessionId as string);
          console.log("[HermesAgentClient] Session ID:", data.sessionId);
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
   * Inject a message into the currently active chat.
   * Returns true if injection succeeded.
   */
  async injectMessage(
    message: string,
    selection?: SelectionContext,
    images?: ImageAttachment[],
  ): Promise<boolean> {
    if (!this.activeChatId) return false;
    try {
      await this.requestBridge("chat/inject", {
        chatId: this.activeChatId,
        message,
        ...(selection && { selection }),
        ...(images?.length && { images }),
      }, 35_000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Interrupt the currently active chat.
   * Returns true if interrupt succeeded.
   */
  async interrupt(): Promise<boolean> {
    if (!this.activeChatId) return false;
    try {
      const result = await this.requestBridge("chat/interrupt", {
        chatId: this.activeChatId,
      }) as { interrupted?: boolean };
      return result.interrupted === true;
    } catch {
      return false;
    }
  }

  /**
   * Check if there's an active chat that can accept steering messages.
   */
  isChatActive(): boolean {
    return this.activeChatId !== null;
  }

  dispose(): void {
    this.socket?.close(1000, "Plugin unloaded");
    this.socket = null;
    const error = new Error("Hermes client disposed");
    this.rejectPendingRequests(error);
    for (const queue of this.chatQueues.values()) queue.fail(error);
    this.chatQueues.clear();
    this.activeChatId = null;
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
      const params = new URLSearchParams();
      if (filters?.status) params.set("status", filters.status);
      if (filters?.file) params.set("file", filters.file);

      const response = await fetch(`${this.bridgeUrl}/sessions?${params}`, { headers: this.getHeaders() });
      if (!response.ok) return [];

      const data = await response.json();
      return data.sessions || [];
    } catch (error) {
      console.warn("[HermesAgentClient] Error fetching sessions:", error);
      return [];
    }
  }

  /**
   * Fetch sessions filtered by type and epoch (for flashcard study sessions)
   */
  async fetchSessionsByType(type: SessionType, epoch: string): Promise<SessionEntry[]> {
    try {
      const params = new URLSearchParams({ type, epoch, status: "in_progress" });
      const response = await fetch(`${this.bridgeUrl}/sessions?${params}`, { headers: this.getHeaders() });
      if (!response.ok) return [];
      const data = await response.json();
      return data.sessions || [];
    } catch (error) {
      console.warn("[HermesAgentClient] Error fetching sessions by type:", error);
      return [];
    }
  }

  /**
   * Update a session's status or title
   */
  async updateSession(sessionId: string, updates: { status?: SessionStatus; title?: string }): Promise<SessionEntry | null> {
    try {
      const response = await fetch(`${this.bridgeUrl}/sessions/${sessionId}`, {
        method: "PATCH",
        headers: this.getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(updates),
      });
      if (!response.ok) return null;

      const data = await response.json();
      return data.session || null;
    } catch (error) {
      console.warn("[HermesAgentClient] Error updating session:", error);
      return null;
    }
  }

  /**
   * Delete a session and all associated files.
   * Returns true if deletion succeeded.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.bridgeUrl}/sessions/${sessionId}`, {
        method: "DELETE",
        headers: this.getHeaders(),
      });
      return response.ok;
    } catch (error) {
      console.warn("[HermesAgentClient] Error deleting session:", error);
      return false;
    }
  }

  /**
   * Trigger one-time migration of JSONL files to registry
   */
  async migrateSessionRegistry(): Promise<number> {
    try {
      const response = await fetch(`${this.bridgeUrl}/sessions/migrate`, {
        method: "POST",
        headers: this.getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      if (!response.ok) return 0;

      const data = await response.json();
      console.log("[HermesAgentClient] Migration result:", data.migrated, "sessions");
      return data.migrated || 0;
    } catch (error) {
      console.warn("[HermesAgentClient] Migration error:", error);
      return 0;
    }
  }

  /**
   * Fetch markers for a session (for dedup checking)
   */
  async fetchMarkers(sessionId: string): Promise<Array<{ markerId: string; flashcardId: string; sourceFile: string; question: string }>> {
    try {
      const response = await fetch(`${this.bridgeUrl}/sessions/${sessionId}/markers`, {
        headers: this.getHeaders(),
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.markers || [];
    } catch (error) {
      console.warn("[HermesAgentClient] Error fetching markers:", error);
      return [];
    }
  }

  /**
   * Update settings
   */
  updateSettings(settings: HermesAgentSettings): void {
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
      console.log("[HermesAgentClient] Fetching history for session:", sessionId);

      const response = await fetch(`${this.bridgeUrl}/history`, {
        method: "POST",
        headers: this.getHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId }),
      });

      if (!response.ok) {
        console.warn("[HermesAgentClient] Failed to fetch history:", response.status);
        return [];
      }

      const data = await response.json();
      console.log("[HermesAgentClient] Fetched", data.messages?.length || 0, "history messages");
      return data.messages || [];
    } catch (error) {
      console.warn("[HermesAgentClient] Error fetching history:", error);
      return [];
    }
  }
}
