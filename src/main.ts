import { Notice, Plugin } from "obsidian";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { ClaudeAgentSettings, DEFAULT_SETTINGS } from "./types";
import { ClaudeAgentSettingTab } from "./settings";
import { ClaudeAgentChatView, CHAT_VIEW_TYPE } from "./ui/ChatView";
import { RelevantNotesView, RELEVANT_NOTES_VIEW_TYPE } from "./ui/RelevantNotesView";
import { ClaudeAgentClient } from "./claude/client";

const PROXY_PORT = 27182;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;

export default class ClaudeAgentPlugin extends Plugin {
  settings: ClaudeAgentSettings = DEFAULT_SETTINGS;
  claudeClient: ClaudeAgentClient | null = null;
  private serverProcess: ChildProcess | null = null;

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

    // Add settings tab
    this.addSettingTab(new ClaudeAgentSettingTab(this.app, this));

    console.log("Claude Agent plugin loaded");
  }

  async onunload(): Promise<void> {
    console.log("Unloading Claude Agent plugin...");
    this.claudeClient = null;
    this.stopServer();
  }

  /**
   * Start the proxy server as a child process
   */
  private startServer(): void {
    if (this.serverProcess) {
      console.log("[ClaudeAgent] Server already running");
      return;
    }

    const vaultPath = (this.app.vault.adapter as any).basePath;
    const pluginDir = path.join(vaultPath, ".obsidian", "plugins", this.manifest.id);
    const serverDir = path.join(pluginDir, "server");

    console.log(`[ClaudeAgent] Starting proxy server from ${serverDir}`);

    // Use shell to inherit PATH for finding node (macOS GUI apps have minimal PATH)
    this.serverProcess = spawn("node", ["index.js"], {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      shell: true,
      env: {
        ...process.env,
        // Ensure common node install locations are in PATH
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
      },
    });

    this.serverProcess.stdout?.on("data", (data) => {
      console.log(`[ClaudeAgent Server] ${data.toString().trim()}`);
    });

    this.serverProcess.stderr?.on("data", (data) => {
      console.error(`[ClaudeAgent Server Error] ${data.toString().trim()}`);
    });

    this.serverProcess.on("error", (err) => {
      console.error("[ClaudeAgent] Failed to start server:", err);
      this.serverProcess = null;
    });

    this.serverProcess.on("exit", (code, signal) => {
      console.error(`[ClaudeAgent] ⚠️ SERVER DIED! Exit code: ${code}, signal: ${signal}`);
      this.serverProcess = null;
    });
  }

  /**
   * Stop the proxy server
   */
  private stopServer(): void {
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
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`${PROXY_URL}/health`);
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
    try {
      const response = await fetch(`${PROXY_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Kill any process using our port (handles orphans from crashed sessions)
   */
  private async killProcessOnPort(): Promise<void> {
    return new Promise((resolve) => {
      // Use lsof to find and kill process on our port
      const killer = spawn("sh", ["-c", `lsof -ti:${PROXY_PORT} | xargs kill -9 2>/dev/null || true`]);
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
   * Initialize the Claude client (auto-starts server if needed)
   */
  private async initializeClient(): Promise<void> {
    try {
      // Always start fresh - kill any existing server first
      // This prevents the flip-flop bug where we detect a dying server
      // from previous session but don't track it for cleanup
      await this.ensureFreshServer();

      // Create the Claude client with vault path for working directory
      const vaultPath = (this.app.vault.adapter as any).basePath;
      this.claudeClient = new ClaudeAgentClient(this.settings, vaultPath);

      // Persist session ID when it changes
      this.claudeClient.setOnSessionChange((sessionId) => {
        this.settings.sessionId = sessionId;
        this.saveSettings();
      });

      await this.claudeClient.initialize();

      console.log("Claude Agent client initialized successfully");
    } catch (error) {
      console.error("Failed to initialize Claude Agent:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

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
   * Load plugin settings
   */
  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
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
