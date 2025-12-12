import { App, PluginSettingTab, Setting } from "obsidian";
import { ClaudeAgentSettings, DEFAULT_SETTINGS } from "./types";
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
      </ul>
      <p>The agent will use MCP servers configured in your Claude settings to search and interact with your vault.</p>
    `;
  }
}
