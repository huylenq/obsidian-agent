# Hermes Agent for Obsidian

An Obsidian plugin that lets you chat with your vault through Hermes Agent over the Agent Client Protocol (ACP).

> **Heads up:** This is a personal, in-progress project built around one specific setup. It is not a polished community release; assumptions leak, APIs move, and bugs occasionally arrive wearing a fake moustache.

![Overview](docs/screenshots/overview.jpg)

## Features

### Chat Interface

![Chat](docs/screenshots/chat.png)

- Stream Hermes responses with full markdown rendering
- Steer an active turn through Hermes' `/steer` ACP command
- Interrupt an active turn with ACP `session/cancel`
- Resume Hermes sessions by ACP session UUID
- `@mention` vault files, attach images, include editor selections, and add the active note as context
- Show Hermes tool calls and results in expandable blocks
- Render Graphviz DOT diagrams inline

![Slash commands](docs/screenshots/slash-commands.jpg)

- Local commands: `/new`, `/done`, `/rename`, `/sessions`
- Hermes command: `/compact`

![Diagram rendering](docs/screenshots/diagram.jpg)

### Semantic Graph View

- Interactive force-directed graph combining wiki-link edges with embedding similarity edges
- Configurable link depth, similarity thresholds, and physics settings
- Pinnable nodes with persistent configuration

### Session Management

- Hermes-native conversation state through ACP `session/new` and `session/load`
- Plugin-owned display transcripts and sidecars under `~/.hermes/obsidian-agent/projects/`
- Session registry with title, status, associated files, flashcard markers, and touched notes
- Browse sessions for the active file or the whole vault

## Architecture

Chat uses one authenticated WebSocket to the Hermes bridge for start, streaming updates, steering, and cancellation. The bridge speaks ACP over stdio to `hermes acp`. HTTP remains only for health, indexing, history, and session metadata, which keeps the same architecture working on Obsidian mobile through a remote bridge.

## Requirements

- **Hermes Agent CLI** — installed, configured, and available as `hermes` on `PATH`
- **OpenAI API Key** — optional, used only for vault indexing in the plugin settings

Validate Hermes before launching Obsidian:

```bash
hermes acp --check
```

## Installation

Clone and build outside your vault, then copy the artifacts into the existing plugin directory.

```bash
git clone <this-repo>
cd agent
pnpm install
pnpm build

PLUGIN_DIR="/path/to/your/vault/.obsidian/plugins/claude-agent"
mkdir -p "$PLUGIN_DIR"
cp dist/main.js dist/styles.css manifest.json "$PLUGIN_DIR/"
cp -r server "$PLUGIN_DIR/"

cd "$PLUGIN_DIR/server"
pnpm install --prod
```

Reload Obsidian or toggle the plugin off and on. In local mode the plugin starts the Hermes bridge, which lazily starts one long-lived `hermes acp` subprocess on the first chat.

### Upgrade compatibility

The manifest, deployment directory, and command IDs retain the original `claude-agent` identity so existing Obsidian settings, hotkeys, and installations continue to work. Runtime class names, CSS classes, primary view types, and events use the `hermes-agent` namespace. The plugin still accepts the former connection filename, view types, and flashcard-explain event as migration aliases.

## Development

```bash
pnpm run build
pnpm --dir server test
pnpm run deploy
pnpm run deploy:deps
```

Use `deploy:deps` for this migration because the bridge adds the `ws` runtime dependency. It replaces the deployed desktop `server/` tree so removed backend files and dependencies cannot linger; ordinary `deploy` remains incremental.
