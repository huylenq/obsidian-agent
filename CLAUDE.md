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
│  - React UI         │   POST /chat      │  - Express          │
│  - Session mgmt     │   POST /inject    │  - Claude Agent SDK │
│  - Message queue    │   POST /interrupt │  - Query Registry   │
└─────────────────────┘                   └─────────────────────┘
```

**Why a proxy?** Claude Agent SDK uses Node.js APIs incompatible with Obsidian's Electron environment.

**Bidirectional communication:** SSE streams responses (server → client). Message injection and interruption use separate HTTP POST endpoints (client → server) targeting an active query by `queryId`.

## Connection Modes

The plugin supports two connection modes, configured in **Settings > Connection**:

| Mode | Platform | How it works |
|------|----------|-------------|
| **Local** (default) | Desktop only | Plugin auto-spawns `server/index.js` as a child process on `localhost:27182` |
| **Remote** | Desktop & Mobile | Plugin connects to an external server URL (e.g. ngrok) with Bearer token auth |

On mobile, remote mode is the only option — there's no Node.js runtime to run the server.

**Auth token** (`settings.remoteAuthToken`) serves double duty:
- In local mode: passed as `AUTH_TOKEN` env var to the spawned server process
- In remote mode: sent as `Authorization: Bearer` header on all requests

**Key files:**
- `src/main.ts` — `getConnectionConfig()` resolves mode, `initializeClient()` conditionally spawns server
- `src/claude/client.ts` — constructor takes `proxyUrl` + optional `authToken`, `getHeaders()` injects auth
- `server/middleware/auth.js` — Express middleware, validates Bearer token if `AUTH_TOKEN` env is set
- `src/state/connectionState.ts` — Jotai atoms for connection status/error
- `src/settings.ts` — Connection section UI (mode dropdown, auth token, remote URL, test button)

**Mobile auto-discovery:**

On mobile, the plugin reads `claude-agent-connection.json` from the vault root before falling back to manual settings. This file is written by `<vault>/scripts/start-mobile-server.sh` on the Mac and syncs via iCloud — zero manual configuration on the phone.

```bash
# from the vault
./scripts/start-mobile-server.sh
```

The connection file has `{ url, authToken, timestamp }`. Files older than 24h are rejected. On Ctrl+C, the script zeroes the file so mobile won't connect to a dead tunnel.

**Mobile constraints:**
- `manifest.json` has `isDesktopOnly: false` to allow enabling on mobile
- Node.js builtins (`child_process`, `path`) are imported with try-catch guard in `main.ts`
- `deploy.js` skips copying `server/` to `.obsidian-mobile` (no Node.js on mobile)

## Key Files

- `server/index.js` - Express app setup, mounts route modules and auth middleware, starts server
- `server/middleware/auth.js` - Bearer token auth (optional via `AUTH_TOKEN` env)
- `server/log.js` - Logging utilities (`log()`, `logError()`)
- `server/transcript.js` - Transcript & summary helpers (read/write JSONL, compact summaries)
- `server/sessions.js` - Session registry helpers (load/save/update registry, transcript inspection)
- `server/asyncIterableController.js` - Pushable AsyncIterable for SDK streaming input
- `server/queryRegistry.js` - In-memory map of active queries (queryId → Query + input controller)
- `server/routes/health.js` - GET /health (unauthenticated, advertises `capabilities`)
- `server/routes/chat.js` - POST /chat (SSE streaming, SDK query), POST /chat/:queryId/inject, POST /chat/:queryId/interrupt, GET /chat/:queryId/status
- `server/routes/history.js` - POST /history (transcript parsing)
- `server/routes/sessions.js` - GET/PATCH /sessions, POST /sessions/migrate
- `src/claude/client.ts` - HTTP client with dynamic URL + auth, manages sessions, injects messages, interrupts queries
- `src/state/chatState.ts` - Jotai atoms for messages, loading, streaming, error
- `src/state/messageQueueState.ts` - Jotai atoms for injected message queue
- `src/ui/ChatView.tsx` - React chat interface
- `src/ui/ChatInput.tsx` - Input field with send/stop button, @mentions, /commands

## Running

**Desktop (local mode):** The plugin auto-starts the proxy server as a child process. Just enable the plugin in Obsidian and click the chat icon.

**Mobile:** Requires a Mac running the server + ngrok. See `Claude Agent Mobile Setup.md` in the vault.

## Development

After making changes:

```bash
pnpm run deploy          # default — skips server/node_modules
pnpm run deploy:deps     # includes server/node_modules (only when deps change)
```

Deploys to both `.obsidian/plugins/claude-agent` (desktop, with server/) and `.obsidian-mobile/plugins/claude-agent` (mobile, files only).

The default skips `server/node_modules` to avoid churning iCloud sync with hundreds of unchanged files. Use `deploy:deps` after changing server dependencies.

Then reload Obsidian (or disable/enable the plugin) to pick up changes.


## Relevant Notes (Vector Search)

Self-owned LanceDB vector index managed by the proxy server.

```
┌─────────────────────────────────────────────────────────────────┐
│  Proxy Server (server/embeddings/)                              │
│  - Scans vault .md files, chunks by headings (6000 chars)       │
│  - Embeds via OpenAI text-embedding-3-small (1536 dims)         │
│  - Stores in LanceDB at <vault>/.obsidian/lance/                │
│  - Incremental updates on startup (mtime-based)                 │
│  - REST endpoints: /index/search, /search-by-path, /pairwise    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AgentIndexClient (src/embeddings/AgentIndexClient.ts)          │
│  - HTTP client using Obsidian's requestUrl (mobile-compatible)  │
│  - Implements IIndexClient interface                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  rankNotes (src/embeddings/search.ts)                           │
│  - 70% similarity + 30% link weight (outgoing links, backlinks) │
│  - Uses app.metadataCache for link graph                        │
└─────────────────────────────────────────────────────────────────┘
```

**Server-side key files:**
- `server/embeddings/embed.js` - OpenAI embeddings API wrapper
- `server/embeddings/chunker.js` - Heading-aware markdown chunking
- `server/embeddings/lanceIndex.js` - LanceDB table operations
- `server/embeddings/indexer.js` - Vault scanner + incremental indexer
- `server/routes/index.js` - REST endpoints (search, pairwise, rebuild, status)

**Client-side key files:**
- `src/embeddings/IIndexClient.ts` - Interface for index clients
- `src/embeddings/AgentIndexClient.ts` - HTTP client implementation
- `src/embeddings/search.ts` - Link-graph reranking (client-side, uses metadataCache)
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
| `{sessionId}.markers.json` | Proxy server | Flashcard marker positions. Array of `{ markerId, flashcardId, sourceFile, question, userMessageIndex, createdAt }`. One entry per flashcard explain. Lazy-migrated from legacy `.threads.json` on read. |
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
- `claude-agent:refresh-sessions` — ChatView → SessionsView (after chat completes, /done, /new)

**Key files:**
- `src/state/sessionState.ts` — Jotai atoms
- `src/ui/SessionsView.tsx` — Standalone ItemView (data fetching + rendering)
- `src/ui/Sessions/SessionCard.tsx` — Card component

## Streaming Input (Message Injection)

Users can send messages while Claude is actively working. Messages are injected into the running SDK session mid-execution, enabling real-time steering.

**Protocol:**

```
POST /chat         → opens SSE stream, sends query_ready { queryId }
                     SDK query() receives AsyncIterable, not a string
POST /chat/:queryId/inject    → pushes SDKUserMessage into the iterable → 202
POST /chat/:queryId/interrupt → calls query.interrupt() → 202
GET  /chat/:queryId/status    → { active: bool, sessionId? }
```

**Server-side flow:**
1. `POST /chat` creates an `AsyncIterableController` and pushes the initial user message
2. The iterable is passed to `query({ prompt: iterable })` — SDK consumes messages as they arrive
3. The query + input controller are registered in `queryRegistry.js` keyed by `queryId`
4. `/inject` pushes new messages into the controller; SDK processes them as follow-up turns
5. `/interrupt` calls `query.interrupt()` to stop execution gracefully
6. On query completion or SSE disconnect, the registry entry is cleaned up (30-min TTL fallback)

**Client-side flow:**
1. `ClaudeAgentClient.chat()` captures `queryId` from the `query_ready` SSE event
2. `isQueryActive()` returns true while `queryId` is set
3. `ChatView.handleSend()` checks `isQueryActive()` — if true, calls `injectMessage()` instead of starting a new query
4. User message appears immediately in chat (optimistic UI); injection status tracked in `messageQueueState`
5. `isStreamingAtom` controls the stop button; cleared on `result` event (turn complete), re-set on injection

**Turn lifecycle with streaming input:**
- SDK emits `result` (subtype `"success"`) when a turn completes — this is the "idle" signal
- `done` only fires when the entire query closes (iterable exhausted or interrupted)
- The SSE connection stays open between turns, allowing follow-up injections
- Text flush and `setStreaming(false)` happen on `result`, not `done`

**Stop button:** Replaces the send button in `ChatInput` when `isStreaming && !input.trim()`. When user types text, the send button reappears (to submit the injection). Uses a ref callback for the send icon to survive conditional remounting.

**Key files:**
- `server/asyncIterableController.js` — `{ iterable, push(value), close() }` utility
- `server/queryRegistry.js` — `registerQuery()`, `getQuery()`, `removeQuery()`, `updateQuerySession()`
- `server/routes/chat.js` — inject/interrupt/status endpoints
- `src/claude/client.ts` — `injectMessage()`, `interrupt()`, `isQueryActive()`, `activeQueryId`
- `src/state/messageQueueState.ts` — `addToQueue()`, `updateQueueStatus()`, `clearQueue()`
- `src/state/chatState.ts` — `isStreamingAtom`, `setStreaming()`

## Slash Commands

Registered in `src/commands/builtins/` and initialized in `src/commands/index.ts`. Autocomplete triggers when typing `/` in the chat input.

- `/new` (aliases: `/clear`, `/reset`) — start new chat session
- `/compact` — compact conversation context (routes through chat pipeline, not a local command)
- `/done` — mark current session as done and start new chat
- `/rename` — rename the current session
- `/sessions` (alias: `/history`) — toggle All Sessions mode in the sessions panel

## Flashcard Explain Integration

Cross-plugin integration with `plugins/inline-flashcards/`. Anki deeplinks trigger flashcard explanations routed to daily study sessions with per-card markers.

### Event flow

```
Anki deeplink → obsidian://flashcard-explain?file=...&content=...&back=...&context=...
  → Inline Flashcards: jumps to card, extracts cardId from <!--ID: \d+-->, dispatches:
    window "claude-agent:explain-flashcard" { question, answer, context, cardId, sourceFile }
  → Claude Agent (main.ts handleExplainFlashcard):
    1. resolveFlashcardSession(epoch) — GET /sessions?type=flashcard_study&epoch=today&status=in_progress
    2. Dedup: fetchMarkers(sessionId), if cardId match → scroll to existing marker, return
    3. Switch to daily session (or clear for new), dispatch "claude-agent:send-message"
  → Server (chat.js finally block):
    1. Merges type/epoch into session registry
    2. Writes marker to {sessionId}.markers.json via appendMarker()
    3. userMessageIndex = countUserOnlyMessages(transcript) - 1
  → History reload (history.js):
    Annotates user messages with markerMetadata at positions mapped from userMessageIndex
```

### Marker navigation (agent → inline-flashcards)

Flashcard bubble clicks dispatch `flashcard:navigate` with `{ sourceFile, flashcardId }`. Inline Flashcards plugin listens, opens the file, finds `<!--ID: {flashcardId}-->`, walks back to the `::` line, scrolls to center, and selection-flashes 3 times. Degrades gracefully if inline-flashcards is not loaded.

### Key files

| File | Role |
|------|------|
| `src/main.ts` | `handleExplainFlashcard` — session resolution, dedup guard (`isHandlingFlashcard`), skip-switch optimization |
| `server/sessions.js` | `countUserOnlyMessages()` — counts user JSONL entries excluding toolUseResult |
| `server/markers.js` | `getMarkersPath()`, `loadMarkers()`, `appendMarker()` — markers sidecar CRUD (lazy-migrates legacy `.threads.json`) |
| `server/routes/chat.js` | Marker writing in finally block, uses `countUserOnlyMessages` for userMessageIndex |
| `server/routes/history.js` | Marker injection — annotates user messages with markerMetadata at userMessageIndex positions |
| `src/ui/ChatMessages.tsx` | `parseFlashcardContent()` — detects flashcard explain messages by content pattern and renders as Δ card |
| `../inline-flashcards/main.ts` | `flashcard:navigate` listener, `navigateToFlashcardById()`, `flashLine()` |

### Flashcard explain bubble

The user message for flashcard explains renders as a styled card instead of the raw prompt text. Detection is **content-based** in the renderer — `parseFlashcardContent()` in `ChatMessages.tsx` matches messages starting with `"Explain this flashcard."` and regex-extracts question/answer/context. No flags or metadata plumbing needed; works identically for live streaming and history reload.

Rendered as: blue Δ symbol (matching inline-flashcards synced color) outside the bubble on the left, user-colored card with question / divider / answer.

### Markers sidecar (`{sessionId}.markers.json`)

```json
[{ "markerId": "uuid", "flashcardId": "1763625939784", "sourceFile": "path.md", "question": "...", "userMessageIndex": 0, "createdAt": 1739577600000 }]
```

`userMessageIndex` = 0-based index into user-only messages (excluding tool results). Must match what history.js counts as user messages when building `userMessagePositions`. Legacy files (`.threads.json` with `threadId`/`startMessageIndex` fields) are lazy-migrated on read by `server/markers.js`.

### Session registry extensions

Sessions with `type: "flashcard_study"` and `epoch: "YYYY-MM-DD"` are daily study sessions. `GET /sessions` accepts `type` and `epoch` query params.

### Dedup

`isHandlingFlashcard` concurrency guard prevents rapid-fire. If card already has a marker in today's session: skip `switch-session` if already viewing that session (avoids message clear + history reload), scroll to existing `[data-flashcard-id]` element, highlight with CSS animation.

### Critical invariant

`countUserOnlyMessages()` must count the same entries that `history.js` renders as `role: "user"` messages. Both exclude `toolUseResult` entries. If history.js adds new skip conditions (e.g. filtering `/compact` commands), `countUserOnlyMessages` may need updating to match — but flashcard sessions don't use compaction so this is low risk.

## Reactive Session Header

The chat view header displays the session title (or "New Chat" / "Flashcard Study · date"). The title is resolved from the session registry via a `useEffect` that depends on `sessionId`, `plugin.claudeClient`, and a `sessionRefreshTrigger` counter. The counter is bumped by a `claude-agent:refresh-sessions` event listener, which fires after chat completion, `/rename`, `/done`, etc. — ensuring the header stays in sync with server-side title changes without requiring a `sessionId` change.
