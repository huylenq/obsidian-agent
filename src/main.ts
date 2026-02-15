import { Notice, Platform, Plugin } from "obsidian";
import { ClaudeAgentSettings, DEFAULT_SETTINGS, DEFAULT_GRAPH_VIEW_SETTINGS } from "./types";
import { ClaudeAgentSettingTab } from "./settings";
import { ClaudeAgentChatView, CHAT_VIEW_TYPE } from "./ui/ChatView";
import { RelevantNotesView, RELEVANT_NOTES_VIEW_TYPE } from "./ui/RelevantNotesView";
import { SessionsView, SESSIONS_VIEW_TYPE } from "./ui/SessionsView";
import { GraphView, GRAPH_VIEW_TYPE } from "./ui/GraphView";
import { ClaudeAgentClient } from "./claude/client";
import { setConnectionStatus, setConnectionError } from "./state/connectionState";

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

const PROXY_PORT = 27181;

interface ConnectionConfig {
  url: string;
  authToken?: string;
}

/** Connection info auto-discovered from vault file (written by start-mobile-server.sh) */
interface ConnectionFile {
  url: string;
  timestamp: number;
}

const CONNECTION_FILE = "claude-agent-connection.json";

/**
 * Get connection URL and auth token based on settings and platform
 */
function getConnectionConfig(settings: ClaudeAgentSettings, isMobile: boolean): ConnectionConfig {
  if (isMobile) {
    if (!settings.remoteServerUrl) {
      throw new Error("No connection file found and no remote URL configured. Run scripts/start-mobile-server.sh on your Mac, or set remote URL manually in settings.");
    }
    return { url: settings.remoteServerUrl, authToken: settings.remoteAuthToken || undefined };
  }
  if (settings.connectionMode === "remote") {
    if (!settings.remoteServerUrl) {
      throw new Error("Remote mode requires server URL — configure it in settings");
    }
    return { url: settings.remoteServerUrl, authToken: settings.remoteAuthToken || undefined };
  }
  return { url: `http://localhost:${PROXY_PORT}`, authToken: settings.remoteAuthToken || undefined };
}

export default class ClaudeAgentPlugin extends Plugin {
  settings: ClaudeAgentSettings = DEFAULT_SETTINGS;
  claudeClient: ClaudeAgentClient | null = null;
  /** The resolved connection URL (may come from auto-discovery or settings) */
  activeConnectionUrl: string | null = null;
  private serverProcess: import("child_process").ChildProcess | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Promise that resolves when initialization is complete
  initializationPromise: Promise<void> | null = null;

  async onload(): Promise<void> {
    console.log("Loading Claude Agent plugin...");

    // Load settings
    await this.loadSettings();

    // IMPORTANT: Create the initialization promise BEFORE registering views.
    // This prevents a race condition where Obsidian restores a view before
    // initializationPromise is assigned, causing "client not initialized" errors.
    this.initializationPromise = this.initializeClient();

    // Register the chat view
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ClaudeAgentChatView(leaf, this));

    // Register the relevant notes view
    this.registerView(RELEVANT_NOTES_VIEW_TYPE, (leaf) => new RelevantNotesView(leaf, this));

    // Register the sessions view
    this.registerView(SESSIONS_VIEW_TYPE, (leaf) => new SessionsView(leaf, this));

    // Register the semantic graph view
    this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphView(leaf, this));

    // Add ribbon icon
    this.addRibbonIcon("message-circle", "Open Claude Agent", () => {
      this.activateChatView();
    });

    // Add command to open chat
    this.addCommand({
      id: "open-claude-agent-chat",
      name: "Open Claude Agent Chat",
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

    // Add command to clear chat (also clears session for fresh conversation)
    this.addCommand({
      id: "clear-claude-agent-chat",
      name: "Clear Chat History",
      callback: async () => {
        const { clearMessages } = await import("./state/chatState");
        clearMessages();
        // Also clear the session so next message starts fresh
        if (this.claudeClient) {
          this.claudeClient.clearSession();
        }
        new Notice("Chat history cleared");
      },
    });

    // Add command to open model selector
    this.addCommand({
      id: "open-model-selector",
      name: "Open Model Selector",
      callback: () => {
        // Dispatch custom event for ChatView to handle
        window.dispatchEvent(new CustomEvent("claude-agent:open-model-selector"));
      },
    });

    // Listen for flashcard explain requests from Inline Flashcards plugin
    const handleExplainFlashcard = (event: CustomEvent<{ question: string; answer: string; context: string }>) => {
      const { question, answer, context } = event.detail;
      // Open chat view first, then dispatch the prompt
      this.activateChatView().then(() => {
        const prompt = this.buildFlashcardExplainPrompt(question, answer, context);
        window.dispatchEvent(new CustomEvent('claude-agent:send-message', { detail: { message: prompt } }));
      });
    };
    window.addEventListener('claude-agent:explain-flashcard', handleExplainFlashcard as EventListener);
    this.register(() => window.removeEventListener('claude-agent:explain-flashcard', handleExplainFlashcard as EventListener));

    // Add settings tab
    this.addSettingTab(new ClaudeAgentSettingTab(this.app, this));

    console.log("Claude Agent plugin loaded");
  }

  private buildFlashcardExplainPrompt(question: string, answer: string, context: string): string {
    let prompt = `Explain this flashcard. The question gives context, elaborate on the answer to help understand the fact intuitively. Focus on the terminologies in the answer.\n\n**Question:**\n${question}\n\n**Answer:**\n${answer}`;
    if (context) {
      prompt += `\n\n**Context:**\n${context}`;
    }
    return prompt;
  }

  async onunload(): Promise<void> {
    console.log("Unloading Claude Agent plugin...");
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.claudeClient = null;
    this.stopServer();
  }

  /**
   * Start the proxy server as a child process
   */
  private startServer(): void {
    if (Platform.isMobile) {
      console.warn("[ClaudeAgent] Cannot start server on mobile platform");
      return;
    }

    if (this.serverProcess) {
      console.log("[ClaudeAgent] Server already running");
      return;
    }

    const vaultPath = (this.app.vault.adapter as any).basePath;
    const pluginDir = path!.join(vaultPath, ".obsidian", "plugins", this.manifest.id);
    const serverDir = path!.join(pluginDir, "server");

    console.log(`[ClaudeAgent] Starting proxy server from ${serverDir}`);

    // Use shell to inherit PATH for finding node (macOS GUI apps have minimal PATH)
    this.serverProcess = spawn!("node", ["index.js"], {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      shell: true,
      env: {
        ...process.env,
        // Ensure common node install locations are in PATH
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
        PORT: String(PROXY_PORT),
        ...(this.settings.remoteAuthToken ? { AUTH_TOKEN: this.settings.remoteAuthToken } : {}),
      },
    });

    this.serverProcess.stdout?.on("data", (data: Buffer) => {
      console.log(`[ClaudeAgent Server] ${data.toString().trim()}`);
    });

    this.serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[ClaudeAgent Server Error] ${data.toString().trim()}`);
    });

    this.serverProcess.on("error", (err: Error) => {
      console.error("[ClaudeAgent] Failed to start server:", err);
      this.serverProcess = null;
    });

    this.serverProcess.on("exit", (code: number | null, signal: string | null) => {
      console.error(`[ClaudeAgent] ⚠️ SERVER DIED! Exit code: ${code}, signal: ${signal}`);
      this.serverProcess = null;
    });
  }

  /**
   * Stop the proxy server
   */
  private stopServer(): void {
    if (Platform.isMobile) {
      return; // No server to stop on mobile
    }

    if (this.serverProcess) {
      console.log("[ClaudeAgent] Stopping proxy server...");
      this.serverProcess.kill();
      this.serverProcess = null;
    }
  }

  /**
   * Wait for the server to be ready (health check with retries)
   */
  private async waitForServer(maxRetries = 30, intervalMs = 200): Promise<boolean> {
    const localUrl = `http://localhost:${PROXY_PORT}`;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${localUrl}/health`);
        if (response.ok) {
          console.log(`[ClaudeAgent] Server ready after ${i + 1} attempts`);
          return true;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  /**
   * Check if server is already running
   */
  private async isServerRunning(): Promise<boolean> {
    const localUrl = `http://localhost:${PROXY_PORT}`;
    try {
      const response = await fetch(`${localUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
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
      const killer = spawn!("sh", ["-c", `lsof -ti:${PROXY_PORT} | xargs kill -9 2>/dev/null || true`]);
      killer.on("close", () => {
        resolve();
      });
      killer.on("error", () => {
        resolve(); // Ignore errors, just proceed
      });
    });
  }

  /**
   * Ensure we have a fresh server instance that we control.
   * This prevents the flip-flop bug where orphaned servers cause alternating failures.
   */
  private async ensureFreshServer(): Promise<void> {
    // Kill our tracked server process if any
    this.stopServer();

    // Forcefully kill ANY process on our port (handles orphans, zombies, TIME_WAIT issues)
    console.log("[ClaudeAgent] Killing any process on port", PROXY_PORT);
    await this.killProcessOnPort();

    // Wait for port to be fully released
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Start fresh server
    console.log("[ClaudeAgent] Starting fresh server...");
    this.startServer();

    const serverReady = await this.waitForServer();
    if (!serverReady) {
      throw new Error("Failed to start proxy server. Check console for details.");
    }
    console.log("[ClaudeAgent] ✅ Server started and health check passed");
  }

  /**
   * Read auto-discovered connection info from vault.
   * Written by scripts/start-mobile-server.sh, synced via iCloud.
   */
  private async readConnectionFile(): Promise<ConnectionFile | null> {
    const exists = await this.app.vault.adapter.exists(CONNECTION_FILE);
    if (!exists) return null;

    const content = await this.app.vault.adapter.read(CONNECTION_FILE);
    const data = JSON.parse(content) as ConnectionFile;
    if (!data.url) {
      throw new Error("Connection file has no url field");
    }

    console.log(`[ClaudeAgent] Found connection file: ${data.url}`);
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

    this.activeConnectionUrl = discovered.url;
    const vaultPath = (this.app.vault.adapter as any).basePath;

    setConnectionStatus("connecting");
    setConnectionError(null);

    try {
      this.claudeClient = new ClaudeAgentClient(
        this.settings,
        vaultPath,
        discovered.url,
        this.settings.remoteAuthToken || undefined,
      );
      this.claudeClient.setOnSessionChange((sessionId) => {
        this.settings.sessionId = sessionId;
        this.saveSettings();
      });
      await this.claudeClient.initialize();
      setConnectionStatus("connected");
      this.startHealthCheck();
      console.log("[ClaudeAgent] Reconnected via connection file:", discovered.url);
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

    const url = this.activeConnectionUrl;
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
        setConnectionError("Server unreachable");
      }
    };

    this.healthCheckInterval = setInterval(check, 30_000);
  }

  /**
   * Initialize the Claude client (auto-starts server if needed)
   */
  private async initializeClient(): Promise<void> {
    try {
      setConnectionStatus("connecting");
      setConnectionError(null);

      // On mobile (or remote mode with no URL), try auto-discovery first
      let connectionConfig: ConnectionConfig;
      const needsDiscovery = Platform.isMobile ||
        (this.settings.connectionMode === "remote" && !this.settings.remoteServerUrl);

      if (needsDiscovery) {
        let discovered: ConnectionFile | null = null;
        try {
          discovered = await this.readConnectionFile();
        } catch (e) {
          console.log("[ClaudeAgent] Connection file discovery failed:", e instanceof Error ? e.message : e);
        }
        if (discovered) {
          connectionConfig = { url: discovered.url, authToken: this.settings.remoteAuthToken || undefined };
          console.log("[ClaudeAgent] Using auto-discovered URL from vault, token from settings");
        } else {
          connectionConfig = getConnectionConfig(this.settings, Platform.isMobile);
        }
      } else {
        connectionConfig = getConnectionConfig(this.settings, Platform.isMobile);
      }

      this.activeConnectionUrl = connectionConfig.url;
      const isLocalMode = this.settings.connectionMode === "local" && !Platform.isMobile;

      // Only start server in local mode on desktop
      if (isLocalMode) {
        console.log("[ClaudeAgent] Local mode: starting proxy server");
        // Always start fresh - kill any existing server first
        // This prevents the flip-flop bug where we detect a dying server
        // from previous session but don't track it for cleanup
        await this.ensureFreshServer();
      } else {
        const mode = Platform.isMobile ? "mobile" : "remote";
        console.log(`[ClaudeAgent] ${mode} mode: connecting to ${connectionConfig.url}`);
      }

      // Create the Claude client with vault path for working directory
      const vaultPath = (this.app.vault.adapter as any).basePath;
      this.claudeClient = new ClaudeAgentClient(
        this.settings,
        vaultPath,
        connectionConfig.url,
        connectionConfig.authToken
      );

      // Persist session ID when it changes
      this.claudeClient.setOnSessionChange((sessionId) => {
        this.settings.sessionId = sessionId;
        this.saveSettings();
      });

      await this.claudeClient.initialize();

      setConnectionStatus("connected");
      this.startHealthCheck();
      console.log("Claude Agent client initialized successfully");
    } catch (error) {
      console.error("Failed to initialize Claude Agent:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      setConnectionStatus("error");
      setConnectionError(errorMessage);

      // Show a notice but don't block the plugin from loading
      new Notice(
        `Claude Agent: ${errorMessage}`,
        10000
      );
    }
  }

  /**
   * Activate or focus the chat view
   */
  async activateChatView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];

    if (!leaf) {
      // Create a new leaf in the right sidebar
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: CHAT_VIEW_TYPE,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      // Focus the chat input after revealing (uses existing event listener in ChatInput)
      window.dispatchEvent(new CustomEvent("claude-agent:focus-input"));
    }
  }

  /**
   * Activate or focus the relevant notes view
   */
  async activateRelevantNotesView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(RELEVANT_NOTES_VIEW_TYPE)[0];

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

    let leaf = workspace.getLeavesOfType(SESSIONS_VIEW_TYPE)[0];

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

    let leaf = workspace.getLeavesOfType(GRAPH_VIEW_TYPE)[0];

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Deep-merge graphSettings so new fields get defaults from DEFAULT_GRAPH_VIEW_SETTINGS
    this.settings.graphSettings = Object.assign(
      {},
      DEFAULT_GRAPH_VIEW_SETTINGS,
      data?.graphSettings,
    );
  }

  /**
   * Save plugin settings
   */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Update the Claude client with new settings
    if (this.claudeClient) {
      this.claudeClient.updateSettings(this.settings);
    }
  }
}
