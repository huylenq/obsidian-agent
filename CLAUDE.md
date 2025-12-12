# Claude Agent for Obsidian

An Obsidian plugin that provides chat with your vault using Claude Agent SDK.

# Rules
- Use pnpm for dependency management

## Architecture

```
┌─────────────────────┐     HTTP/SSE      ┌─────────────────────┐
│  Obsidian Plugin    │ ←───────────────→ │   Proxy Server      │
│  (src/)             │                   │   (server/)         │
│                     │                   │                     │
│  - React UI         │                   │  - Express          │
│  - Session mgmt     │                   │  - Claude Agent SDK │
└─────────────────────┘                   └─────────────────────┘
```

**Why a proxy?** Claude Agent SDK uses Node.js APIs incompatible with Obsidian's Electron environment.

## Key Files

- `server/index.js` - Proxy server with `/chat` endpoint, handles SDK queries and SSE streaming
- `src/claude/client.ts` - HTTP client, manages sessions
- `src/ui/ChatView.tsx` - React chat interface

## Running

```bash
# Terminal 1: Start proxy server
cd server && pnpm start

# Obsidian: Enable plugin, click chat icon
```

## MCP Integration

The agent uses MCP servers configured in:
- `~/.claude/settings.json` (user settings)
- `<vault>/.claude/settings.json` (project settings)

Set via `settingSources: ["user", "project"]` and `workingDirectory` pointing to the vault path.