import { App, PluginSettingTab, Setting } from "obsidian";
import { ClaudeAgentSettings, ConnectionMode, DEFAULT_SETTINGS } from "./types";
import type ClaudeAgentPlugin from "./main";

export class ClaudeAgentSettingTab extends PluginSettingTab {
  plugin: ClaudeAgentPlugin;

  constructor(app: App, plugin: ClaudeAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Claude Agent Settings" });

    // Connection section
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Connection Mode")
      .setDesc("Local: auto-starts proxy server. Remote: connects to an external server (for mobile).")
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
          ? "Shared secret for the server. Set this on desktop, then use the same token on mobile to connect."
          : "Bearer token to authenticate with the remote server."
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
        .setName("Remote Server URL")
        .setDesc("Full URL of the proxy server (e.g. https://abc123.ngrok.io)")
        .addText((text) =>
          text
            .setPlaceholder("https://your-server.ngrok.io")
            .setValue(this.plugin.settings.remoteServerUrl)
            .onChange(async (value) => {
              this.plugin.settings.remoteServerUrl = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Test Connection")
        .setDesc("Verify the remote server is reachable")
        .addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            const url = this.plugin.settings.remoteServerUrl;
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

    // System Prompt
    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc(
        "Customize the system prompt that guides Claude's behavior when answering questions about your vault."
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
        <li><strong>Claude Code CLI</strong> - Must be installed and authenticated</li>
        <li><strong>Proxy Server</strong> - Run <code>cd server && npm start</code></li>
        <li><strong>MCP Servers</strong> - Configure in <code>~/.claude/settings.json</code> or vault's <code>.claude/</code></li>
        <li><strong>Mobile</strong> - Set Connection Mode to "Remote" and configure your server URL + auth token</li>
      </ul>
      <p>The agent will use MCP servers configured in your Claude settings to search and interact with your vault.</p>
    `;
  }
}
