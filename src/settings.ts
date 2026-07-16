import { App, PluginSettingTab, Setting } from "obsidian";
import { HermesAgentSettings, ConnectionMode, DEFAULT_SETTINGS } from "./types";
import type HermesAgentPlugin from "./main";

export class HermesAgentSettingTab extends PluginSettingTab {
  plugin: HermesAgentPlugin;

  constructor(app: App, plugin: HermesAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Hermes Agent Settings" });

    // Connection section
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Connection Mode")
      .setDesc("Local: auto-starts the Hermes bridge. Remote: connects to an external bridge (for mobile).")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("local", "Local")
          .addOption("remote", "Remote")
          .setValue(this.plugin.settings.connectionMode)
          .onChange(async (value) => {
            this.plugin.settings.connectionMode = value as ConnectionMode;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Auth Token")
      .setDesc(
        this.plugin.settings.connectionMode === "local"
          ? "Shared secret for the bridge. Set this on desktop, then use the same token on mobile to connect."
          : "Token used to authenticate with the remote bridge."
      )
      .addText((text) => {
        text
          .setPlaceholder("Enter auth token...")
          .setValue(this.plugin.settings.remoteAuthToken)
          .onChange(async (value) => {
            this.plugin.settings.remoteAuthToken = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    if (this.plugin.settings.connectionMode === "remote") {
      new Setting(containerEl)
        .setName("Remote Bridge URL")
        .setDesc("Full URL of the Hermes bridge (e.g. https://abc123.ngrok.io). Leave blank to use auto-discovered URL from connection file.")
        .addText((text) =>
          text
            .setPlaceholder("https://your-server.ngrok.io")
            .setValue(this.plugin.settings.remoteBridgeUrl)
            .onChange(async (value) => {
              this.plugin.settings.remoteBridgeUrl = value;
              await this.plugin.saveSettings();
            })
        );

      // Show auto-discovered URL if active and no manual URL is set
      const activeUrl = this.plugin.activeBridgeUrl;
      if (activeUrl && !this.plugin.settings.remoteBridgeUrl) {
        new Setting(containerEl)
          .setName("Active URL (auto-discovered)")
          .setDesc(activeUrl);
      }

      // Reload connection file (useful when iCloud sync is slow)
      new Setting(containerEl)
        .setName("Reload Connection File")
        .setDesc("Re-read hermes-agent-connection.json from vault (iCloud may delay sync)")
        .addButton((button) =>
          button.setButtonText("Reload").onClick(async () => {
            button.setButtonText("Loading...");
            try {
              const result = await this.plugin.reloadConnectionFile();
              if (result) {
                button.setButtonText(`Found: ${result.url.replace(/^https?:\/\//, "").slice(0, 30)}`);
                this.display(); // Refresh to show new active URL
              } else {
                button.setButtonText("File not found");
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : "Failed";
              button.setButtonText(msg.slice(0, 30));
            }
            setTimeout(() => button.setButtonText("Reload"), 4000);
          })
        );

      new Setting(containerEl)
        .setName("Test Connection")
        .setDesc("Verify the remote Hermes bridge is reachable")
        .addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            // Use active URL (may be auto-discovered), fall back to settings
            const url = this.plugin.activeBridgeUrl || this.plugin.settings.remoteBridgeUrl;
            if (!url) {
              button.setButtonText("No URL set");
              setTimeout(() => button.setButtonText("Test"), 2000);
              return;
            }
            button.setButtonText("Testing...");
            const base = url.replace(/\/$/, "");
            const headers: Record<string, string> = {
              "ngrok-skip-browser-warning": "1",
            };
            if (this.plugin.settings.remoteAuthToken) {
              headers["Authorization"] = `Bearer ${this.plugin.settings.remoteAuthToken}`;
            }
            try {
              // Test an authenticated endpoint, not just /health
              const response = await fetch(`${base}/sessions?workingDirectory=/tmp`, { headers });
              if (response.ok) {
                button.setButtonText("Connected!");
              } else if (response.status === 401) {
                button.setButtonText("Auth failed (401)");
              } else {
                button.setButtonText(`Failed (${response.status})`);
              }
            } catch {
              button.setButtonText("Unreachable");
            }
            setTimeout(() => button.setButtonText("Test"), 3000);
          })
        );
    }

    // Indexing
    containerEl.createEl("h3", { text: "Indexing" });

    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("Required for vault indexing (text-embedding-3-small). Used by the bridge to generate embeddings for Relevant Notes and Semantic Graph.")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    // System Prompt
    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc(
        "Customize the instructions Hermes receives with each vault prompt."
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("Enter your system prompt...")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          })
      );

    // Make the textarea larger
    const systemPromptTextarea = containerEl.querySelector(
      "textarea"
    ) as HTMLTextAreaElement;
    if (systemPromptTextarea) {
      systemPromptTextarea.rows = 8;
      systemPromptTextarea.style.width = "100%";
    }

    // Show Debug Info
    new Setting(containerEl)
      .setName("Show Debug Info")
      .setDesc(
        "Display tool calls and search operations in the chat interface."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showDebugInfo)
          .onChange(async (value) => {
            this.plugin.settings.showDebugInfo = value;
            await this.plugin.saveSettings();
          })
      );

    // Reset to Defaults
    new Setting(containerEl)
      .setName("Reset to Defaults")
      .setDesc("Reset all settings to their default values.")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          this.plugin.settings = { ...DEFAULT_SETTINGS };
          await this.plugin.saveSettings();
          this.display(); // Refresh the settings page
        })
      );

    // Info Section
    containerEl.createEl("h3", { text: "Requirements" });

    const infoEl = containerEl.createEl("div", { cls: "setting-item-description" });
    infoEl.innerHTML = `
      <p>This plugin requires:</p>
      <ul>
        <li><strong>Hermes Agent CLI</strong> - <code>hermes</code> must be installed, configured, and available on PATH</li>
        <li><strong>Hermes bridge</strong> - Run <code>cd server && pnpm start</code></li>
        <li><strong>Hermes tools and MCP servers</strong> - Configure through Hermes</li>
        <li><strong>Mobile</strong> - Set Connection Mode to "Remote" and configure your bridge URL + auth token</li>
      </ul>
      <p>The bridge starts <code>hermes acp</code>; Hermes loads its tools, MCP servers, rules, and memory for the vault working directory.</p>
    `;
  }
}
