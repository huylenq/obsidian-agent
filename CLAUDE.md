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

- `server/index.js` - Express app setup, mounts route modules, starts server
- `server/log.js` - Logging utilities (`log()`, `logError()`)
- `server/transcript.js` - Transcript & summary helpers (read/write JSONL, compact summaries)
- `server/sessions.js` - Session registry helpers (load/save/update registry, transcript inspection)
- `server/routes/health.js` - GET /health
- `server/routes/chat.js` - POST /chat (SSE streaming, SDK query)
- `server/routes/history.js` - POST /history (transcript parsing)
- `server/routes/sessions.js` - GET/PATCH /sessions, POST /sessions/migrate
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

## `~/.claude/` Files We Read and Write

The proxy server reads and writes files under `~/.claude/projects/{encoded-path}/` where `{encoded-path}` is the vault's absolute path with `/`, spaces, and `~` replaced by `-`.

For the IWE vault, that resolves to:
`~/.claude/projects/-Users-huy-Library-Mobile-Documents-iCloud-md-obsidian-Documents-IWE/`

### Files managed by Claude Code SDK (read-only to us)

| File pattern | Description |
|---|---|
| `{sessionId}.jsonl` | Session transcript — one JSON object per line. Contains `user`, `assistant`, `system` entries with `message`, `timestamp`, `type`/`subtype` fields. SDK creates these; we only read them. |

### Files we create and manage

| File pattern | Owner | Description |
|---|---|---|
| `{sessionId}.summaries.json` | Proxy server | Compact summaries sidecar. Array of `{ timestamp, preTokens, summary }`. One entry per `/compact` invocation. Written by the proxy after generating a synthetic summary via Haiku. |
| `session-registry.json` | Proxy server | Central session registry. Single JSON file tracking all sessions with metadata (title, status, timestamps, model, associated files). See schema below. |

### Session Registry schema (`session-registry.json`)

```jsonc
{
  "version": 1,
  "sessions": [
    {
      "id": "uuid",              // matches JSONL filename
      "title": "First message",  // first user message, 80 chars max
      "status": "in_progress",   // "in_progress" | "done"
      "createdAt": 1700000000,   // epoch ms
      "updatedAt": 1700000000,   // epoch ms, updated after each /chat
      "model": "haiku",          // "haiku" | "sonnet" | "opus"
      "messageCount": 12,        // user + assistant messages
      "files": ["path/to/note.md"]  // vault-relative paths (deduped)
    }
  ]
}
```

**How the registry is populated:**
- **Migration** (`POST /sessions/migrate`): One-time scan of all `.jsonl` files. Extracts title from first user message, timestamps, file paths from `currently viewing: **path**` patterns. Skips empty files and warmup/sidechain sessions (`isSidechain: true` or first message is "Warmup"). Migrated sessions default to `status: "done"`.
- **Ongoing** (`POST /chat` finally block): After each chat completes, upserts the session entry with current model, message count, `updatedAt`, and merges file paths from `activeFile`, `mentionedFiles`, and `relevantNotes`.
- **Manual** (`PATCH /sessions/:id`): Client can update `status` and `title` (used by `/done` command and status toggle in UI).

## Compaction

Long conversations are managed via the Agent SDK's compaction feature. The `/compact` slash command triggers it.

**Flow:** `/compact` → proxy sends to SDK → SDK summarizes internally and emits `compact_boundary` → proxy reads transcript segment, generates a synthetic summary via Haiku (cwd: `/tmp/claude-agent-compact-summaries`), persists to sidecar file → client renders collapsible boundary divider with summary.

**Key details:**
- Synthetic summaries stored at `~/.claude/projects/{encoded-path}/{sessionId}.summaries.json`
- Throwaway Haiku sessions for summarization use `/tmp/claude-agent-compact-summaries` as cwd to avoid polluting the main project's transcripts
- UI groups messages by compact boundaries — compacted groups are collapsed by default, expandable on click
- SDK injects a synthetic user message after `compact_boundary` in the transcript containing its own detailed summary — captured as `sdkSummary` and rendered with markdown in the boundary UI
- History endpoint filters compaction artifacts from transcript: `/compact` command, SDK's "Compacted" acknowledgment, `<local-command-caveat>` system injections

## Session Management

Sessions are tracked via a central registry file (see `~/.claude/` section above). The proxy server exposes three endpoints and the client/UI provide browsing and switching.

**Server endpoints:**
- `GET /sessions?workingDirectory=...&status=...&file=...` — list sessions, sorted by `updatedAt` desc
- `PATCH /sessions/:sessionId` — update `status` and/or `title`
- `POST /sessions/migrate` — one-time JSONL scan to populate registry

**UI — standalone `SessionsView`** (`src/ui/SessionsView.tsx`): Separate `ItemView` (like `RelevantNotesView`), registered in `main.ts`. Owns its own data fetching, active-file tracking, and migration trigger. Two modes:
- **"This File"** (default) — auto-fetches sessions associated with the active file on `active-leaf-change`
- **"All Sessions"** — shows all sessions vault-wide with status filtering (Active / All)

**Cross-view communication** via custom events (same pattern as RelevantNotes → ChatView):
- `claude-agent:switch-session` — SessionsView → ChatView (loads history for selected session)
- `claude-agent:session-changed` — ChatView → SessionsView (sync current session ID)
- `claude-agent:refresh-sessions` — ChatView → SessionsView (after chat completes, /done, /clear)

**Key files:**
- `src/state/sessionState.ts` — Jotai atoms
- `src/ui/SessionsView.tsx` — Standalone ItemView (data fetching + rendering)
- `src/ui/Sessions/SessionCard.tsx` — Card component

## Slash Commands

Registered in `src/commands/builtins/` and initialized in `src/commands/index.ts`. Autocomplete triggers when typing `/` in the chat input.

- `/clear` (aliases: `/new`, `/reset`) — start fresh session
- `/compact` — compact conversation context (routes through chat pipeline, not a local command)
- `/done` — mark current session as done and start new chat
- `/sessions` (alias: `/history`) — toggle All Sessions mode in the sessions panel
