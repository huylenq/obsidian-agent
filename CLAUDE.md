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

The plugin auto-starts the proxy server as a child process. Just enable the plugin in Obsidian and click the chat icon.

## Development

After making changes:

```bash
pnpm run deploy
```

Then reload Obsidian (or disable/enable the plugin) to pick up changes.


## Relevant Notes (Vector Search)

Reuses obsidian-copilot's existing vector index instead of building our own.

```
┌─────────────────────────────────────────────────────────────────┐
│  Copilot Index (read-only)                                      │
│  .obsidian/copilot-index-chunk-{hash}-{0..N}.json               │
│  └─ docs.docs[id] = { path, title, content, embedding[1536] }   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  CopilotIndexReader (src/embeddings/VectorStore.ts)             │
│  - Parses JSON directly (no Orama dependency)                   │
│  - Brute-force cosine similarity search O(n)                    │
│  - Deduplicates chunks by path, keeps highest similarity        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  rankNotes (src/embeddings/search.ts)                           │
│  - 70% similarity + 30% link weight (outgoing links, backlinks) │
│  - Uses app.metadataCache for link graph                        │
└─────────────────────────────────────────────────────────────────┘
```

**Key files:**
- `src/embeddings/VectorStore.ts` - CopilotIndexReader class
- `src/embeddings/search.ts` - Ranking with link weighting
- `src/ui/RelevantNotes/` - UI components

**Modes:**
- Current file: finds notes similar to active file's embedding
- Chat context: (planned) embed recent messages for search

## MCP Integration

The agent uses MCP servers configured in:
- `~/.claude/settings.json` (user settings)
- `<vault>/.claude/settings.json` (project settings)

Set via `settingSources: ["user", "project", "local"]` and `workingDirectory` pointing to the vault path.

## Compaction

Long conversations are managed via the Agent SDK's compaction feature. The `/compact` slash command triggers it.

**Flow:** `/compact` → proxy sends to SDK → SDK summarizes internally and emits `compact_boundary` → proxy reads transcript segment, generates a synthetic summary via Haiku (cwd: `/tmp/claude-agent-compact-summaries`), persists to sidecar file → client renders collapsible boundary divider with summary.

**Key details:**
- Synthetic summaries stored at `~/.claude/projects/{encoded-path}/{sessionId}.summaries.json`
- Throwaway Haiku sessions for summarization use `/tmp/claude-agent-compact-summaries` as cwd to avoid polluting the main project's transcripts
- UI groups messages by compact boundaries — compacted groups are collapsed by default, expandable on click
- SDK injects a synthetic user message after `compact_boundary` in the transcript containing its own detailed summary — captured as `sdkSummary` and rendered with markdown in the boundary UI
- History endpoint filters compaction artifacts from transcript: `/compact` command, SDK's "Compacted" acknowledgment, `<local-command-caveat>` system injections

## Slash Commands

Registered in `src/commands/builtins/` and initialized in `src/commands/index.ts`. Autocomplete triggers when typing `/` in the chat input.

- `/clear` (aliases: `/new`, `/reset`) — start fresh session
- `/compact` — compact conversation context (routes through chat pipeline, not a local command)
