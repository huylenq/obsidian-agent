import { Notice, Plugin } from "obsidian";
import { ClaudeAgentSettings, DEFAULT_SETTINGS } from "./types";
import { ClaudeAgentSettingTab } from "./settings";
import { ClaudeAgentChatView, CHAT_VIEW_TYPE } from "./ui/ChatView";
import { ClaudeAgentClient } from "./claude/client";

export default class ClaudeAgentPlugin extends Plugin {
  settings: ClaudeAgentSettings = DEFAULT_SETTINGS;
  claudeClient: ClaudeAgentClient | null = null;

  async onload(): Promise<void> {
    console.log("Loading Claude Agent plugin...");

    // Load settings
    await this.loadSettings();

    // Register the chat view
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ClaudeAgentChatView(leaf, this));

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

    // Add settings tab
    this.addSettingTab(new ClaudeAgentSettingTab(this.app, this));

    // Initialize the client
    await this.initializeClient();

    console.log("Claude Agent plugin loaded");
  }

  async onunload(): Promise<void> {
    console.log("Unloading Claude Agent plugin...");
    this.claudeClient = null;
  }

  /**
   * Initialize the Claude client
   */
  private async initializeClient(): Promise<void> {
    try {
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
