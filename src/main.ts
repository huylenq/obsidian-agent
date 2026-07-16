import { Notice, Platform, Plugin, TFile, WorkspaceLeaf, requestUrl } from "obsidian";
import { HermesAgentSettings, DEFAULT_SETTINGS, DEFAULT_GRAPH_VIEW_SETTINGS } from "./types";
import { HermesAgentSettingTab } from "./settings";
import { HermesAgentChatView, CHAT_VIEW_TYPE } from "./ui/ChatView";
import { RelevantNotesView, RELEVANT_NOTES_VIEW_TYPE } from "./ui/RelevantNotesView";
import { SessionsView, SESSIONS_VIEW_TYPE } from "./ui/SessionsView";
import { GraphView, GRAPH_VIEW_TYPE } from "./ui/GraphView";
import { HermesAgentClient } from "./hermes/client";
import { AgentIndexClient, rankNotes } from "./embeddings";
import type { IndexStatus } from "./embeddings/AgentIndexClient";
import type { RankedNote } from "./types";
import { setConnectionStatus, setConnectionError } from "./state/connectionState";
import { AGENT_EVENTS } from "./events";
import {
  LEGACY_COMMAND_IDS,
  LEGACY_CONNECTION_FILE,
  LEGACY_EVENTS,
  LEGACY_SETTING_KEYS,
  LEGACY_VIEW_TYPES,
} from "./legacy";

// Node.js imports - only available on desktop.
// These are external in esbuild, so `require()` is emitted as-is in the bundle.
// On mobile, these modules don't exist — the try-catch prevents the entire
// plugin from failing to load.
let spawn: typeof import("child_process").spawn | undefined;
let path: typeof import("path") | undefined;
try {
  if (!Platform.isMobile) {
    spawn = require("child_process").spawn;
    path = require("path");
  }
} catch {
  // Expected on mobile — Node.js builtins unavailable
}

const BRIDGE_PORT = 27182;

interface ConnectionConfig {
  url: string;
  authToken?: string;
}

/** Connection info auto-discovered from vault file (written by start-mobile-server.sh) */
interface ConnectionFile {
  url: string;
  timestamp: number;
}

const CONNECTION_FILE = "hermes-agent-connection.json";

/**
 * Get connection URL and auth token based on settings and platform
 */
function getConnectionConfig(settings: HermesAgentSettings, isMobile: boolean): ConnectionConfig {
  if (isMobile) {
    if (!settings.remoteBridgeUrl) {
      throw new Error("No connection file found and no remote URL configured. Run scripts/start-mobile-server.sh on your Mac, or set remote URL manually in settings.");
    }
    return { url: settings.remoteBridgeUrl, authToken: settings.remoteAuthToken || undefined };
  }
  if (settings.connectionMode === "remote") {
    if (!settings.remoteBridgeUrl) {
      throw new Error("Remote mode requires a bridge URL — configure it in settings");
    }
    return { url: settings.remoteBridgeUrl, authToken: settings.remoteAuthToken || undefined };
  }
  return { url: `http://localhost:${BRIDGE_PORT}`, authToken: settings.remoteAuthToken || undefined };
}

export default class HermesAgentPlugin extends Plugin {
  settings: HermesAgentSettings = DEFAULT_SETTINGS;
  hermesClient: HermesAgentClient | null = null;
  vectorStore: AgentIndexClient | null = null;
  /** The resolved connection URL (may come from auto-discovery or settings) */
  activeBridgeUrl: string | null = null;
  private bridgeProcess: import("child_process").ChildProcess | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private indexStatusBar: HTMLElement | null = null;
  private indexPollTimer: ReturnType<typeof setTimeout> | null = null;
  private indexIdleHideTimer: ReturnType<typeof setTimeout> | null = null;
  private isHandlingFlashcard = false;
  /** Content-based dedup: tracks flashcard prompts already sent in this plugin lifecycle */
  private sentFlashcardPrompts = new Set<string>();
  /** Tracks the epoch of the most recently dispatched flashcard session (guards TOCTOU race with registry) */
  private pendingFlashcardEpoch: string | null = null;

  // Promise that resolves when initialization is complete
  initializationPromise: Promise<void> | null = null;

  async onload(): Promise<void> {
    console.log("Loading Hermes Agent plugin...");

    // Load settings
    await this.loadSettings();

    // IMPORTANT: Create the initialization promise BEFORE registering views.
    // This prevents a race condition where Obsidian restores a view before
    // initializationPromise is assigned, causing "client not initialized" errors.
    this.initializationPromise = this.initializeClient();

    // Init vector store after the bridge is ready.
    this.initializationPromise.then(() => this.initVectorStore());

    // Register the chat view
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new HermesAgentChatView(leaf, this));
    this.registerView(LEGACY_VIEW_TYPES.chat, (leaf) =>
      new HermesAgentChatView(leaf, this, LEGACY_VIEW_TYPES.chat)
    );

    // Register the relevant notes view
    this.registerView(RELEVANT_NOTES_VIEW_TYPE, (leaf) => new RelevantNotesView(leaf, this));
    this.registerView(LEGACY_VIEW_TYPES.relevantNotes, (leaf) =>
      new RelevantNotesView(leaf, this, LEGACY_VIEW_TYPES.relevantNotes)
    );

    // Register the sessions view
    this.registerView(SESSIONS_VIEW_TYPE, (leaf) => new SessionsView(leaf, this));
    this.registerView(LEGACY_VIEW_TYPES.sessions, (leaf) =>
      new SessionsView(leaf, this, LEGACY_VIEW_TYPES.sessions)
    );

    // Register the semantic graph view
    this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphView(leaf, this));
    this.registerView(LEGACY_VIEW_TYPES.graph, (leaf) =>
      new GraphView(leaf, this, LEGACY_VIEW_TYPES.graph)
    );

    // Add ribbon icon
    this.addRibbonIcon("message-circle", "Open Hermes Agent", () => {
      this.activateChatView();
    });

    // Add command to open chat
    this.addCommand({
      id: LEGACY_COMMAND_IDS.openChat,
      name: "Open Hermes Agent Chat",
      callback: () => {
        this.activateChatView();
      },
    });

    // Add command to open relevant notes
    this.addCommand({
      id: "open-relevant-notes",
      name: "Open Relevant Notes",
      callback: () => {
        this.activateRelevantNotesView();
      },
    });

    // Add command to open sessions
    this.addCommand({
      id: "open-sessions",
      name: "Open Sessions",
      callback: () => {
        this.activateSessionsView();
      },
    });

    // Add command to open semantic graph
    this.addCommand({
      id: "open-semantic-graph",
      name: "Open Semantic Graph",
      callback: () => {
        this.activateGraphView();
      },
    });

    // Add command to start new chat (clears session for fresh conversation)
    this.addCommand({
      id: LEGACY_COMMAND_IDS.newChat,
      name: "New Chat",
      callback: async () => {
        const { clearMessages } = await import("./state/chatState");
        clearMessages();
        // Also clear the session so next message starts fresh
        if (this.hermesClient) {
          this.hermesClient.clearSession();
        }
        this.sentFlashcardPrompts.clear();
        this.pendingFlashcardEpoch = null;
        new Notice("New chat started");
      },
    });

    // Add command to open model selector
    this.addCommand({
      id: "open-model-selector",
      name: "Open Model Selector",
      callback: () => {
        window.dispatchEvent(new CustomEvent(AGENT_EVENTS.openModelSelector));
      },
    });

    // Add command to show plugin version
    this.addCommand({
      id: "show-version",
      name: "Show Version",
      callback: () => {
        new Notice(`Hermes Agent v${this.manifest.version}`);
      },
    });

    // Add command to open session switcher dropdown
    this.addCommand({
      id: "open-session-switcher",
      name: "Open Session Switcher",
      callback: () => {
        this.activateChatView().then(() => {
          window.dispatchEvent(new CustomEvent(AGENT_EVENTS.openSessionSwitcher));
        });
      },
    });

    this.addCommand({
      id: "rebuild-semantic-index",
      name: "Rebuild Semantic Index",
      callback: () => this.rebuildSemanticIndex(),
    });

    this.indexStatusBar = this.addStatusBarItem();
    this.indexStatusBar.addClass("hermes-agent-index-status");
    this.indexStatusBar.style.cursor = "pointer";
    this.indexStatusBar.style.display = "none";
    this.indexStatusBar.onclick = () => this.rebuildSemanticIndex();
    this.pokeIndexStatus();

    // Listen for flashcard explain requests from Inline Flashcards plugin
    const handleExplainFlashcard = (event: CustomEvent<{ question: string; answer: string; context: string; cardId?: string; sourceFile?: string }>) => {
      const { question, answer, context } = event.detail;
      // sourceFile from deeplink; fallback: extract file path from context ("path.md > heading > ...")
      const sourceFile = event.detail.sourceFile
        || (context ? context.split(" > ")[0].trim() : "");

      // Concurrency guard — prevent rapid-fire duplicate handling
      if (this.isHandlingFlashcard) {
        console.log("[HermesAgent] Ignoring flashcard request — already handling one");
        return;
      }
      this.isHandlingFlashcard = true;

      this.activateChatView().then(async () => {
        try {
          // Content-based dedup key (stable — doesn't include enrichment that varies per call)
          const dedupKey = `${question}\n${answer}\n${context}`;
          console.log("[FC-dedup] dedupKey length:", dedupKey.length, "| sourceFile:", sourceFile, "| question preview:", question?.slice(0, 60));

          // Extract card ID + file content from vault (source of truth — deeplink cardId is unreliable)
          let cardId: string | null = null;
          let fileContent = "";
          if (sourceFile && question) {
            const extracted = await this.extractCardIdFromVault(sourceFile, question);
            cardId = extracted.cardId;
            fileContent = extracted.fileContent;
          }
          console.log("[FC-dedup] vault-extracted cardId:", cardId);

          const epoch = new Date().toISOString().slice(0, 10);

          // Resolve or prepare daily flashcard session
          let targetSessionId: string | null = null;
          if (this.hermesClient) {
            targetSessionId = await this.resolveFlashcardSession(epoch);
          }

          const currentSessionId = this.hermesClient?.getSessionId() ?? null;
          console.log("[FC-dedup] targetSession:", targetSessionId, "| currentSession:", currentSessionId);

          // Helper: switch to target session if not already viewing it
          const ensureTargetSession = async () => {
            if (targetSessionId && currentSessionId !== targetSessionId) {
              console.log("[FC-dedup] switching session:", currentSessionId, "→", targetSessionId);
              const switchDone = new Promise<void>(resolve => {
                const handler = () => {
                  window.removeEventListener(AGENT_EVENTS.switchSessionDone, handler);
                  resolve();
                };
                window.addEventListener(AGENT_EVENTS.switchSessionDone, handler);
                // Safety timeout in case the event never fires
                setTimeout(() => {
                  window.removeEventListener(AGENT_EVENTS.switchSessionDone, handler);
                  resolve();
                }, 3000);
              });
              window.dispatchEvent(new CustomEvent(AGENT_EVENTS.switchSession, {
                detail: { sessionId: targetSessionId },
              }));
              await switchDone;
            }
          };

          // Dedup layer 1: marker-based (works across plugin reloads)
          if (targetSessionId && cardId) {
            const markers = await this.hermesClient!.fetchMarkers(targetSessionId);
            const existing = markers.find(m => m.flashcardId === cardId);
            console.log("[FC-dedup] marker check:", markers.length, "markers,", "match:", !!existing);
            if (existing) {
              console.log("[FC-dedup] ✓ DEDUP via markers — scrolling to existing");
              await ensureTargetSession();
              window.dispatchEvent(new CustomEvent(AGENT_EVENTS.scrollToFlashcard, {
                detail: { flashcardId: cardId },
              }));
              return;
            }
          } else {
            console.log("[FC-dedup] marker check skipped — targetSession:", !!targetSessionId, "cardId:", !!cardId);
          }

          // Dedup layer 2: content-based (catches duplicates during streaming)
          const contentDedupHit = this.sentFlashcardPrompts.has(dedupKey);
          console.log("[FC-dedup] content check: sentPrompts size:", this.sentFlashcardPrompts.size, "| hit:", contentDedupHit);
          if (contentDedupHit) {
            await ensureTargetSession();
            if (cardId) {
              console.log("[FC-dedup] ✓ DEDUP via content — scrolling to cardId:", cardId);
              window.dispatchEvent(new CustomEvent(AGENT_EVENTS.scrollToFlashcard, {
                detail: { flashcardId: cardId },
              }));
            } else {
              console.log("[FC-dedup] ✓ DEDUP via content — but NO cardId, cannot scroll (vault extraction failed)");
            }
            return;
          }

          console.log("[FC-dedup] ✗ no dedup match — sending new explain");

          if (targetSessionId) {
            await ensureTargetSession();
          } else {
            // Clear session so SDK creates a new one
            if (this.hermesClient) {
              this.hermesClient.clearSession();
              const { clearMessages } = await import("./state/chatState");
              clearMessages();
            }
          }

          // Gather vault context (vector-similar notes + sibling cards)
          const { relevantNotes: fcRelevantNotes, siblingCards } = await this.gatherFlashcardContext(
            sourceFile, context, fileContent, question
          );

          const prompt = this.buildFlashcardExplainPrompt(question, answer, context, siblingCards);

          console.log("[FC] prompt:", prompt);

          const decodedQuestion = question ? decodeURIComponent(question.replace(/\+/g, ' ')) : '';

          // Mark as sent BEFORE dispatching to prevent duplicates during streaming
          this.sentFlashcardPrompts.add(dedupKey);
          // Track pending epoch so resolveFlashcardSession can find this session
          // before the registry is updated (TOCTOU guard)
          this.pendingFlashcardEpoch = epoch;
          console.log("[FC-dedup] added to sentPrompts, new size:", this.sentFlashcardPrompts.size);

          window.dispatchEvent(new CustomEvent(AGENT_EVENTS.sendMessage, {
            detail: {
              message: prompt,
              flashcardMeta: sourceFile ? { cardId: cardId || '', sourceFile, question: decodedQuestion } : undefined,
              sessionMeta: { type: "flashcard_study" as const, epoch },
              relevantNotes: fcRelevantNotes.length > 0 ? fcRelevantNotes : undefined,
            },
          }));
        } finally {
          this.isHandlingFlashcard = false;
        }
      });
    };
    for (const eventName of [AGENT_EVENTS.explainFlashcard, LEGACY_EVENTS.explainFlashcard]) {
      window.addEventListener(eventName, handleExplainFlashcard as EventListener);
      this.register(() => window.removeEventListener(eventName, handleExplainFlashcard as EventListener));
    }

    // Listen for view relocation requests (from toggle button in ChatView)
    const handleRelocateView = (event: CustomEvent<{ location: "sidebar" | "tab" }>) => {
      this.relocateChatView(event.detail.location);
    };
    window.addEventListener(AGENT_EVENTS.relocateView, handleRelocateView as EventListener);
    this.register(() => window.removeEventListener(AGENT_EVENTS.relocateView, handleRelocateView as EventListener));

    // Add settings tab
    this.addSettingTab(new HermesAgentSettingTab(this.app, this));

    console.log("Hermes Agent plugin loaded");
  }

  private async initVectorStore(): Promise<void> {
    if (!this.hermesClient) return;
    const client = new AgentIndexClient(
      this.hermesClient.bridgeUrl,
      this.hermesClient.authToken
    );
    if (await client.initialize()) {
      this.vectorStore = client;
      console.log("[HermesAgent] Vector store initialized for flashcard enrichment");
    }
  }

  /**
   * Gather vault context for a flashcard: vector-similar notes + sibling cards under same heading.
   */
  private async gatherFlashcardContext(
    sourceFile: string, context: string, fileContent: string, question: string
  ): Promise<{ relevantNotes: RankedNote[]; siblingCards: string[] }> {
    // Vector search + link-graph ranking
    let fcRelevantNotes: RankedNote[] = [];
    if (this.vectorStore) {
      const raw = await this.vectorStore.searchSimilarToPath(sourceFile, { limit: 5, minSimilarity: 0.45 });
      fcRelevantNotes = rankNotes(raw, sourceFile, this.app);
    }

    // Sibling flashcard extraction from the same heading section
    const siblingCards: string[] = [];
    if (fileContent && context) {
      const headingPath = context.split(" > ").slice(1); // drop file name
      const anchor = headingPath.length > 0 ? headingPath[headingPath.length - 1].trim() : null;

      if (anchor) {
        const lines = fileContent.split("\n");
        let inSection = false;
        let anchorLevel = 0;

        for (const line of lines) {
          const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
          if (headingMatch) {
            const level = headingMatch[1].length;
            const title = headingMatch[2].trim();
            if (!inSection && title === anchor) {
              inSection = true;
              anchorLevel = level;
              continue;
            }
            if (inSection && level <= anchorLevel) {
              break; // left the section
            }
          }
          if (inSection) {
            const fcMatch = line.match(HermesAgentPlugin.FLASHCARD_LINE_RE);
            if (fcMatch) {
              const q = fcMatch[4].trim();
              const a = fcMatch[7].trim();
              // Skip the card being explained (fuzzy match on question)
              const qNorm = q.replace(/[^\w\s]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
              const questionNorm = question.replace(/<[^>]+>/g, "").replace(/[^\w\s]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
              if (qNorm.includes(questionNorm) || questionNorm.includes(qNorm)) continue;
              siblingCards.push(`${q}:: ${a}`);
            }
          }
        }
      }
    }

    console.log("[HermesAgent] Flashcard context:", fcRelevantNotes.length, "relevant notes,", siblingCards.length, "sibling cards");
    return { relevantNotes: fcRelevantNotes, siblingCards };
  }

  /**
   * Find an existing in_progress flashcard_study session for the given epoch (today).
   * Returns the session ID if found, null otherwise.
   *
   * Handles TOCTOU race: the registry is only updated with type/epoch in the
   * bridge chat completion. If a second explain arrives before the first
   * chat completes, the registry query returns nothing. We fall back to the
   * current session if we recently dispatched a flashcard request for this epoch.
   */
  private async resolveFlashcardSession(epoch: string): Promise<string | null> {
    if (!this.hermesClient) return null;

    // Check the bridge registry first (authoritative once updated)
    const sessions = await this.hermesClient.fetchSessionsByType("flashcard_study", epoch);
    if (sessions.length > 0) return sessions[0].id;

    // Fallback: registry not yet updated — use current session if we dispatched
    // a flashcard request for this same epoch
    const currentId = this.hermesClient.getSessionId();
    if (currentId && this.pendingFlashcardEpoch === epoch) {
      console.log("[FC-resolve] registry miss, using pending session:", currentId);
      return currentId;
    }

    return null;
  }

  private buildFlashcardExplainPrompt(question: string, answer: string, context: string, siblingCards: string[]): string {
    // Preamble sections go BEFORE **Question:** so parseFlashcardContent regex ignores them
    let preamble = "Explain this flashcard in the style of Andrej Karpathy — build understanding from first principles. Start from something the reader already knows, layer up to the answer so the 'aha' feels inevitable. Use concrete analogies and simple examples to make abstract ideas tangible. Unpack key terminologies so they *click*, not just stick. Keep it concise — if a 3-sentence explanation nails it, don't write 10. Connect to relevant notes in this Obsidian vault where possible.";

    if (siblingCards.length > 0) {
      preamble += `\n\nOther flashcards under the same heading (for context, don't explain these):\n${siblingCards.map(c => `- ${c}`).join("\n")}`;
    }

    preamble += "\n\nYou have MCP tools available (Readwise highlights, Lance vault search, Karakeep bookmarks). Use them if the answer references concepts worth cross-referencing.";

    let prompt = `${preamble}\n\n**Question:**\n${question}\n\n**Answer:**\n${answer}`;
    if (context) {
      prompt += `\n\n**Context:**\n${context}`;
    }
    return prompt;
  }

  /** ∆ question?:: answer — also matches bullet list items (- ∆, * ∆, + ∆) */
  private static FLASHCARD_LINE_RE = /^(\s*(?:[-*+]\s+)?)(∆)(\s)(.+?)(\?::)(\s*)(.+)$/;

  /**
   * Extract the Anki card ID from the vault file's <!--ID: \d+--> comment.
   * This is the source of truth — deeplink cardId is unreliable (especially mobile Anki).
   */
  private async extractCardIdFromVault(sourceFile: string, questionHtml: string): Promise<{ cardId: string | null; fileContent: string }> {
    const file = this.app.vault.getAbstractFileByPath(
      sourceFile.endsWith(".md") ? sourceFile : `${sourceFile}.md`
    );
    if (!(file instanceof TFile)) return { cardId: null, fileContent: "" };

    const content = await this.app.vault.cachedRead(file);
    const lines = content.split("\n");

    // Normalize the HTML question for matching (strip tags + non-alphanumeric)
    const normalized = questionHtml
      .replace(/<[^>]+>/g, "")
      .replace(/[^\w\s]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(HermesAgentPlugin.FLASHCARD_LINE_RE);
      if (!match) continue;

      const question = match[4].replace(/[^\w\s]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!(question.includes(normalized) || normalized.includes(question))) continue;

      // Found the flashcard line — check next line for Anki ID
      if (i + 1 < lines.length) {
        const idMatch = lines[i + 1].match(/<!--ID:\s*(\d+)-->/);
        if (idMatch) return { cardId: idMatch[1], fileContent: content };
      }
      return { cardId: null, fileContent: content }; // flashcard found but no ID comment
    }
    return { cardId: null, fileContent: content };
  }

  async onunload(): Promise<void> {
    console.log("Unloading Hermes Agent plugin...");
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.indexPollTimer) clearTimeout(this.indexPollTimer);
    if (this.indexIdleHideTimer) clearTimeout(this.indexIdleHideTimer);
    this.hermesClient?.dispose();
    this.hermesClient = null;
    this.stopBridge();
  }

  async rebuildSemanticIndex(): Promise<void> {
    if (!this.vectorStore) {
      new Notice("Hermes Agent not connected");
      return;
    }
    const ok = await this.vectorStore.reload();
    if (!ok) {
      new Notice("Rebuild failed");
      return;
    }
    new Notice("Rebuilding semantic index…");
    this.pokeIndexStatus();
  }

  /** One-shot status fetch + render. If indexing, schedules the next poll. */
  private async pokeIndexStatus(): Promise<void> {
    if (this.indexPollTimer) {
      clearTimeout(this.indexPollTimer);
      this.indexPollTimer = null;
    }
    if (!this.hermesClient || !this.indexStatusBar) return;
    let status: IndexStatus | null = null;
    try {
      const res = await requestUrl({
        url: `${this.hermesClient.bridgeUrl}/index/status`,
        headers: this.hermesClient.authToken
          ? { Authorization: `Bearer ${this.hermesClient.authToken}` }
          : {},
      });
      status = res.json as IndexStatus;
    } catch {
      this.indexStatusBar.style.display = "none";
      return;
    }
    this.renderIndexStatus(status);
    if (status.indexing) {
      this.indexPollTimer = setTimeout(() => this.pokeIndexStatus(), 1500);
    }
  }

  private renderIndexStatus(status: IndexStatus): void {
    if (!this.indexStatusBar) return;
    if (this.indexIdleHideTimer) {
      clearTimeout(this.indexIdleHideTimer);
      this.indexIdleHideTimer = null;
    }
    if (status.indexing) {
      const p = status.progress;
      const text = p && p.total > 0 ? `⟳ Indexing ${p.indexed} / ${p.total}` : "⟳ Indexing…";
      this.indexStatusBar.setText(text);
      this.indexStatusBar.title = "Click to rebuild semantic index";
      this.indexStatusBar.style.display = "";
      return;
    }
    // Idle: briefly flash done state if we were just polling, otherwise stay hidden
    const wasVisible = this.indexStatusBar.style.display !== "none";
    if (wasVisible) {
      this.indexStatusBar.setText(`✓ Indexed ${status.docCount} chunks`);
      this.indexIdleHideTimer = setTimeout(() => {
        if (this.indexStatusBar) this.indexStatusBar.style.display = "none";
      }, 3000);
    } else {
      this.indexStatusBar.style.display = "none";
    }
    this.indexStatusBar.title = status.lastBuiltAt
      ? `Index up to date · last built ${new Date(status.lastBuiltAt).toLocaleString()} · click to rebuild`
      : "Click to rebuild semantic index";
  }

  /**
   * Start the Hermes bridge as a child process
   */
  private startBridge(): void {
    if (Platform.isMobile) {
      console.warn("[HermesAgent] Cannot start the Hermes bridge on mobile");
      return;
    }

    if (this.bridgeProcess) {
      console.log("[HermesAgent] Bridge already running");
      return;
    }

    const vaultPath = (this.app.vault.adapter as any).basePath;
    const pluginDir = path!.join(vaultPath, ".obsidian", "plugins", this.manifest.id);
    const bridgeDir = path!.join(pluginDir, "server");

    console.log(`[HermesAgent] Starting Hermes bridge from ${bridgeDir}`);

    // Use shell to inherit PATH for finding node (macOS GUI apps have minimal PATH)
    this.bridgeProcess = spawn!("node", ["index.js"], {
      cwd: bridgeDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      shell: true,
      env: {
        ...process.env,
        // Ensure common node install locations are in PATH
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
        PORT: String(BRIDGE_PORT),
        ...(this.settings.remoteAuthToken ? { AUTH_TOKEN: this.settings.remoteAuthToken } : {}),
        ...(this.settings.openaiApiKey ? { OPENAI_API_KEY: this.settings.openaiApiKey } : {}),
      },
    });

    this.bridgeProcess.stdout?.on("data", (data: Buffer) => {
      console.log(`[HermesAgent Bridge] ${data.toString().trim()}`);
    });

    this.bridgeProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[HermesAgent Bridge Error] ${data.toString().trim()}`);
    });

    this.bridgeProcess.on("error", (err: Error) => {
      console.error("[HermesAgent] Failed to start bridge:", err);
      this.bridgeProcess = null;
    });

    this.bridgeProcess.on("exit", (code: number | null, signal: string | null) => {
      console.error(`[HermesAgent] ⚠️ BRIDGE DIED! Exit code: ${code}, signal: ${signal}`);
      this.bridgeProcess = null;
    });
  }

  /**
   * Stop the Hermes bridge
   */
  private stopBridge(): void {
    if (Platform.isMobile) {
      return; // No local bridge to stop on mobile
    }

    if (this.bridgeProcess) {
      console.log("[HermesAgent] Stopping Hermes bridge...");
      this.bridgeProcess.kill();
      this.bridgeProcess = null;
    }
  }

  /**
   * Wait for the bridge to be ready (health check with retries)
   */
  private async waitForBridge(maxRetries = 30, intervalMs = 200): Promise<boolean> {
    const localUrl = `http://localhost:${BRIDGE_PORT}`;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${localUrl}/health`);
        if (response.ok) {
          console.log(`[HermesAgent] Bridge ready after ${i + 1} attempts`);
          return true;
        }
      } catch {
        // Bridge not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  /**
   * Kill any process using our port (handles orphans from crashed sessions)
   */
  private async killProcessOnPort(): Promise<void> {
    if (Platform.isMobile) {
      return; // No process management on mobile
    }

    return new Promise((resolve) => {
      // Use lsof to find and kill process on our port
      const killer = spawn!("sh", ["-c", `lsof -ti:${BRIDGE_PORT} | xargs kill -9 2>/dev/null || true`]);
      killer.on("close", () => {
        resolve();
      });
      killer.on("error", () => {
        resolve(); // Ignore errors, just proceed
      });
    });
  }

  /**
   * Ensure we have a fresh bridge instance that we control.
   * This prevents orphaned bridge processes from causing alternating failures.
   */
  private async ensureFreshBridge(): Promise<void> {
    // Kill our tracked bridge process if any
    this.stopBridge();

    // Forcefully kill ANY process on our port (handles orphans, zombies, TIME_WAIT issues)
    console.log("[HermesAgent] Killing any process on port", BRIDGE_PORT);
    await this.killProcessOnPort();

    // Wait for port to be fully released
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Start a fresh bridge.
    console.log("[HermesAgent] Starting fresh bridge...");
    this.startBridge();

    const bridgeReady = await this.waitForBridge();
    if (!bridgeReady) {
      throw new Error("Failed to start Hermes bridge. Check console for details.");
    }
    console.log("[HermesAgent] ✅ Bridge started and health check passed");
  }

  /**
   * Read auto-discovered connection info from vault.
   * Written by scripts/start-mobile-server.sh, synced via iCloud.
   */
  private async readConnectionFile(): Promise<ConnectionFile | null> {
    const fileName = (await this.app.vault.adapter.exists(CONNECTION_FILE))
      ? CONNECTION_FILE
      : (await this.app.vault.adapter.exists(LEGACY_CONNECTION_FILE))
        ? LEGACY_CONNECTION_FILE
        : null;
    if (!fileName) return null;

    const content = await this.app.vault.adapter.read(fileName);
    const data = JSON.parse(content) as ConnectionFile;
    if (!data.url) {
      throw new Error("Connection file has no url field");
    }

    console.log(`[HermesAgent] Found connection file ${fileName}: ${data.url}`);
    return data;
  }

  /**
   * Re-read the connection file and re-initialize the client.
   * Useful when iCloud hasn't synced the file by plugin startup time.
   */
  async reloadConnectionFile(): Promise<{ url: string } | null> {
    const discovered = await this.readConnectionFile(); // throws on errors
    if (!discovered) {
      throw new Error(`${CONNECTION_FILE} not found in vault root`);
    }

    this.activeBridgeUrl = discovered.url;
    const vaultPath = (this.app.vault.adapter as any).basePath;

    setConnectionStatus("connecting");
    setConnectionError(null);

    try {
      this.hermesClient?.dispose();
      this.hermesClient = new HermesAgentClient(
        this.settings,
        vaultPath,
        discovered.url,
        this.settings.remoteAuthToken || undefined,
      );
      this.hermesClient.setOnSessionChange((sessionId) => {
        this.settings.sessionId = sessionId;
        this.saveSettings();
      });
      await this.hermesClient.initialize();
      setConnectionStatus("connected");
      this.startHealthCheck();
      this.pokeIndexStatus();
      console.log("[HermesAgent] Reconnected via connection file:", discovered.url);
      return { url: discovered.url };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      setConnectionStatus("error");
      setConnectionError(msg);
      throw error;
    }
  }

  /**
   * Periodic health check — updates connection status dot in real time.
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    const url = this.activeBridgeUrl;
    if (!url) return;

    const check = async () => {
      try {
        const headers: Record<string, string> = { "ngrok-skip-browser-warning": "1" };
        if (this.settings.remoteAuthToken) {
          headers["Authorization"] = `Bearer ${this.settings.remoteAuthToken}`;
        }
        const resp = await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          setConnectionStatus("connected");
          setConnectionError(null);
        } else {
          setConnectionStatus("error");
          setConnectionError(`Health check returned ${resp.status}`);
        }
      } catch {
        setConnectionStatus("error");
        setConnectionError("Hermes bridge unreachable");
      }
    };

    this.healthCheckInterval = setInterval(check, 30_000);
  }

  /**
   * Initialize the Hermes client (auto-starts the bridge if needed)
   */
  private async initializeClient(): Promise<void> {
    try {
      setConnectionStatus("connecting");
      setConnectionError(null);

      // On mobile (or remote mode with no URL), try auto-discovery first
      let connectionConfig: ConnectionConfig;
      const needsDiscovery = Platform.isMobile ||
        (this.settings.connectionMode === "remote" && !this.settings.remoteBridgeUrl);

      if (needsDiscovery) {
        let discovered: ConnectionFile | null = null;
        try {
          discovered = await this.readConnectionFile();
        } catch (e) {
          console.log("[HermesAgent] Connection file discovery failed:", e instanceof Error ? e.message : e);
        }
        if (discovered) {
          connectionConfig = { url: discovered.url, authToken: this.settings.remoteAuthToken || undefined };
          console.log("[HermesAgent] Using auto-discovered URL from vault, token from settings");
        } else {
          connectionConfig = getConnectionConfig(this.settings, Platform.isMobile);
        }
      } else {
        connectionConfig = getConnectionConfig(this.settings, Platform.isMobile);
      }

      this.activeBridgeUrl = connectionConfig.url;
      const isLocalMode = this.settings.connectionMode === "local" && !Platform.isMobile;

      // Only start the bridge locally on desktop.
      if (isLocalMode) {
        console.log("[HermesAgent] Local mode: starting Hermes bridge");
        // Always start fresh - kill any existing bridge first.
        // This prevents the flip-flop bug where we detect a dying bridge
        // from previous session but don't track it for cleanup
        await this.ensureFreshBridge();
      } else {
        const mode = Platform.isMobile ? "mobile" : "remote";
        console.log(`[HermesAgent] ${mode} mode: connecting to ${connectionConfig.url}`);
      }

      // Create the bridge client with the vault path used by Hermes ACP.
      const vaultPath = (this.app.vault.adapter as any).basePath;
      this.hermesClient = new HermesAgentClient(
        this.settings,
        vaultPath,
        connectionConfig.url,
        connectionConfig.authToken
      );

      // Persist session ID when it changes
      this.hermesClient.setOnSessionChange((sessionId) => {
        this.settings.sessionId = sessionId;
        this.saveSettings();
      });

      await this.hermesClient.initialize();

      setConnectionStatus("connected");
      this.startHealthCheck();
      this.pokeIndexStatus();
      console.log("Hermes Agent client initialized successfully");
    } catch (error) {
      console.error("Failed to initialize Hermes Agent:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      setConnectionStatus("error");
      setConnectionError(errorMessage);

      // Show a notice but don't block the plugin from loading
      new Notice(
        `Hermes Agent: ${errorMessage}`,
        10000
      );
    }
  }

  /**
   * Activate or focus the chat view
   */
  async activateChatView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]
      ?? workspace.getLeavesOfType(LEGACY_VIEW_TYPES.chat)[0];

    if (!leaf) {
      // Create leaf based on saved preference
      if (this.settings.chatViewLocation === "tab") {
        leaf = workspace.getLeaf("tab");
      } else {
        const rightLeaf = workspace.getRightLeaf(false);
        if (rightLeaf) {
          leaf = rightLeaf;
        }
      }
      if (leaf) {
        await leaf.setViewState({
          type: CHAT_VIEW_TYPE,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      // Focus the chat input after revealing (uses existing event listener in ChatInput)
      window.dispatchEvent(new CustomEvent(AGENT_EVENTS.focusInput));
    }
  }

  /**
   * Relocate the chat view between sidebar and center tab
   */
  async relocateChatView(location: "sidebar" | "tab"): Promise<void> {
    const { workspace } = this.app;

    // Close existing chat view
    const existingLeaves = [
      ...workspace.getLeavesOfType(CHAT_VIEW_TYPE),
      ...workspace.getLeavesOfType(LEGACY_VIEW_TYPES.chat),
    ];
    for (const leaf of existingLeaves) {
      leaf.detach();
    }

    // Create new leaf in the target location
    let newLeaf: WorkspaceLeaf | null = null;
    if (location === "tab") {
      newLeaf = workspace.getLeaf("tab");
    } else {
      newLeaf = workspace.getRightLeaf(false);
    }

    if (newLeaf) {
      await newLeaf.setViewState({
        type: CHAT_VIEW_TYPE,
        active: true,
      });
      workspace.revealLeaf(newLeaf);
      window.dispatchEvent(new CustomEvent(AGENT_EVENTS.focusInput));
    }
  }

  /**
   * Activate or focus the relevant notes view
   */
  async activateRelevantNotesView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(RELEVANT_NOTES_VIEW_TYPE)[0]
      ?? workspace.getLeavesOfType(LEGACY_VIEW_TYPES.relevantNotes)[0];

    if (!leaf) {
      // Create a new leaf in the right sidebar
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: RELEVANT_NOTES_VIEW_TYPE,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /**
   * Activate or focus the sessions view
   */
  async activateSessionsView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(SESSIONS_VIEW_TYPE)[0]
      ?? workspace.getLeavesOfType(LEGACY_VIEW_TYPES.sessions)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: SESSIONS_VIEW_TYPE,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /**
   * Activate or focus the semantic graph view
   */
  async activateGraphView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(GRAPH_VIEW_TYPE)[0]
      ?? workspace.getLeavesOfType(LEGACY_VIEW_TYPES.graph)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: GRAPH_VIEW_TYPE,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /**
   * Load plugin settings
   */
  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    const normalizedData = { ...(data ?? {}) };
    const legacyBridgeUrl = normalizedData[LEGACY_SETTING_KEYS.remoteBridgeUrl];
    const migratedRemoteBridgeUrl = !normalizedData.remoteBridgeUrl && legacyBridgeUrl;
    if (migratedRemoteBridgeUrl) normalizedData.remoteBridgeUrl = legacyBridgeUrl;
    delete normalizedData[LEGACY_SETTING_KEYS.remoteBridgeUrl];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, normalizedData);
    const migratedFromLegacyBackend = data?.sessionBackend !== "hermes-acp";
    if (migratedFromLegacyBackend) {
      // Legacy SDK session UUIDs cannot be resumed by Hermes. Keep the old
      // files untouched, but start this backend with a fresh ACP session.
      this.settings.sessionId = null;
    }
    this.settings.sessionBackend = "hermes-acp";
    // Pre-ACP provider aliases cannot be sent to ACP. Concrete ACP choices are
    // preserved and refreshed from the live session when the chat view opens.
    if (["haiku", "sonnet", "opus"].includes(this.settings.model)) {
      this.settings.model = "hermes";
    }
    // Deep-merge graphSettings so new fields get defaults from DEFAULT_GRAPH_VIEW_SETTINGS
    this.settings.graphSettings = Object.assign(
      {},
      DEFAULT_GRAPH_VIEW_SETTINGS,
      data?.graphSettings,
    );
    if (migratedFromLegacyBackend || migratedRemoteBridgeUrl) {
      await this.saveData(this.settings);
    }
  }

  /**
   * Save plugin settings
   */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Update the Hermes client with new settings
    if (this.hermesClient) {
      this.hermesClient.updateSettings(this.settings);
    }
  }
}
