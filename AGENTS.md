# Hermes Agent for Obsidian

An Obsidian plugin that provides chat with your vault using Hermes Agent over ACP.

# Rules
- Use pnpm for dependency management

## Architecture

```
┌─────────────────────┐    WebSocket      ┌─────────────────────┐     ACP stdio
│  Obsidian Plugin    │ ←───────────────→ │   Hermes Bridge     │ ←────────────→ `hermes acp`
│  (src/)             │    /bridge        │   (server/)         │
│                     │                   │                     │
│  - React UI         │    HTTP REST      │  - WebSocket bridge │
│  - Session mgmt     │ ────────────────→ │  - Express APIs     │
│  - Message queue    │ health/index/etc. │  - Storage + index  │
└─────────────────────┘                   └─────────────────────┘
```

**Why a bridge?** ACP uses a long-lived stdio subprocess, which cannot run in Obsidian mobile and should not live inside the renderer process. The bridge owns that subprocess and exposes one bidirectional WebSocket that works from both desktop and mobile.

**Transport split:** Chat start, streamed events, steering, and cancellation use JSON-RPC-style messages over `/bridge`. HTTP remains only for health, indexing, history, and session metadata.

## Connection Modes

The plugin supports two connection modes, configured in **Settings > Connection**:

| Mode | Platform | How it works |
|------|----------|-------------|
| **Local** (default) | Desktop only | Plugin auto-spawns `server/index.js` as a child process on `localhost:27182` |
| **Remote** | Desktop & Mobile | Plugin connects to an external bridge URL (e.g. ngrok) |

On mobile, remote mode is the only option — there's no Node.js runtime to run the bridge.

**Auth token** (`settings.remoteAuthToken`) serves double duty:
- In local mode: passed as `AUTH_TOKEN` to the spawned bridge process
- WebSocket: sent in the first `bridge/authenticate` request
- HTTP support APIs: sent as an `Authorization: Bearer` header

**Key files:**
- `src/main.ts` — `getConnectionConfig()` resolves mode, `initializeClient()` conditionally spawns the bridge
- `src/hermes/client.ts` — owns the WebSocket, JSON-RPC request correlation, chat event queues, and HTTP support calls
- `server/hermesBridge.js` — WebSocket authentication and method dispatch
- `server/middleware/auth.js` — Express middleware, validates Bearer token if `AUTH_TOKEN` env is set
- `src/state/connectionState.ts` — Jotai atoms for connection status/error
- `src/settings.ts` — Connection section UI (mode dropdown, auth token, remote URL, test button)

**Mobile auto-discovery:**

On mobile, the plugin reads `hermes-agent-connection.json` from the vault root before falling back to manual settings. For upgrades, it also accepts the former connection filename. This file is written by `<vault>/scripts/start-mobile-server.sh` on the Mac and syncs via iCloud — zero manual configuration on the phone.

```bash
# from the vault
./scripts/start-mobile-server.sh
```

The connection file has `{ url, timestamp }`; the auth token comes from plugin settings. On Ctrl+C, the script zeroes the file so mobile won't connect to a dead tunnel.

**Mobile constraints:**
- `manifest.json` has `isDesktopOnly: false` to allow enabling on mobile
- Node.js builtins (`child_process`, `path`) are imported with try-catch guard in `main.ts`
- `deploy.js` skips copying `server/` to `.obsidian-mobile` (no Node.js on mobile)

## Key Files

- `server/index.js` - HTTP server setup, mounts support APIs, and attaches the WebSocket bridge
- `server/middleware/auth.js` - Bearer token auth (optional via `AUTH_TOKEN` env)
- `server/log.js` - Logging utilities (`log()`, `logError()`)
- `server/hermesAcpClient.js` - Long-lived JSON-RPC client for `hermes acp`; lifecycle, request demux, session updates, and permission replies
- `server/storage.js` - Hermes-side project storage paths
- `server/transcript.js` - Plugin-owned JSONL transcript helpers
- `server/sessions.js` - Session registry helpers (load/save/update registry, transcript inspection)
- `server/hermesBridge.js` - `/bridge` WebSocket endpoint and per-connection active-chat map
- `server/chatSession.js` - One chat lifecycle: ACP prompt/update projection, steering, cancellation, transcripts, markers, and registry updates
- `server/routes/health.js` - GET /health (unauthenticated, advertises `capabilities`)
- `server/routes/history.js` - POST /history (transcript parsing)
- `server/routes/sessions.js` - GET/PATCH /sessions, POST /sessions/migrate
- `src/hermes/client.ts` - WebSocket bridge client plus HTTP support API client
- `src/events.ts` - Canonical `hermes-agent:` runtime event names
- `src/legacy.ts` - Upgrade-only command, view, connection-file, and event aliases from the pre-ACP plugin identity
- `src/state/chatState.ts` - Jotai atoms for messages, loading, streaming, error
- `src/state/messageQueueState.ts` - Jotai atoms for injected message queue
- `src/ui/ChatView.tsx` - React chat interface
- `src/ui/ChatInput.tsx` - Input field with send/stop button, @mentions, /commands

## Running

**Desktop (local mode):** The plugin auto-starts the Hermes bridge as a child process. Just enable the plugin in Obsidian and click the chat icon.

**Mobile:** Requires a Mac running the bridge + ngrok. See the mobile setup note in the vault.

## Development

After making changes:

```bash
pnpm run deploy          # default — skips server/node_modules
pnpm run deploy:deps     # includes server/node_modules (only when deps change)
pnpm --dir server test   # bridge protocol unit tests
```

Deploys to both `.obsidian/plugins/claude-agent` (desktop, with server/) and `.obsidian-mobile/plugins/claude-agent` (mobile, files only). These directories retain the manifest's legacy plugin id for upgrade compatibility.

The default skips `server/node_modules` to avoid churning iCloud sync with hundreds of unchanged files. Use `deploy:deps` after changing server dependencies; it replaces the deployed desktop `server/` tree before copying the current bridge and flattened runtime dependencies.

Then reload Obsidian (or disable/enable the plugin) to pick up changes.


## Relevant Notes (Vector Search)

Self-owned LanceDB vector index managed by the Hermes bridge.

```
┌─────────────────────────────────────────────────────────────────┐
│  Hermes Bridge (server/embeddings/)                              │
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

Hermes owns its tool and MCP configuration. The bridge passes an empty `mcpServers` array at ACP session open, so Hermes loads the tools, MCP servers, rules, skills, and memory configured in its own environment and for the vault working directory.

## `~/.hermes/obsidian-agent/` Files We Manage

Hermes stores the actual model conversation in its own session database. The bridge separately writes display-compatible JSONL and sidecars under `~/.hermes/obsidian-agent/projects/{encoded-path}/`, where `{encoded-path}` is the vault's absolute path with `/`, spaces, and `~` replaced by `-`.

For the IWE vault, that resolves to:
`~/.hermes/obsidian-agent/projects/-Users-huy-Library-Mobile-Documents-iCloud-md-obsidian-Documents-IWE/`

### Files we create and manage

| File pattern | Owner | Description |
|---|---|---|
| `{sessionId}.jsonl` | Hermes bridge | Display transcript projected from ACP message and tool updates. Hermes' own session DB remains the source of truth for model context. |
| `{sessionId}.markers.json` | Hermes bridge | Flashcard marker positions. Array of `{ markerId, flashcardId, sourceFile, question, userMessageIndex, createdAt }`. One entry per flashcard explain. Lazy-migrated from legacy `.threads.json` on read. |
| `{sessionId}.touched.json` | Hermes bridge | Causal working set of vault files for a session. `{ version: 1, entries: [{ path, op, count, firstAt, lastAt }] }`. Recorded by the chat pipeline whenever the agent calls Read/Write/Edit on a `file_path`. Distinct from RelevantNotes (which is similarity-based) — this answers "which notes did the agent actually touch?", a stronger signal of what the session was really about. Deduped by `path`; the latest op wins (Edit-after-Read promotes the entry to `edit`). |
| `session-registry.json` | Hermes bridge | Central session registry. Single JSON file tracking all sessions with metadata (title, status, timestamps, model, associated files). See schema below. |

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
      "model": "hermes",         // concrete model selection belongs to Hermes
      "messageCount": 12,        // user + assistant messages
      "files": ["path/to/note.md"]  // vault-relative paths (deduped)
    }
  ]
}
```

**How the registry is populated:**
- **Migration** (`POST /sessions/migrate`): One-time scan of all `.jsonl` files. Extracts title from first user message, timestamps, file paths from `currently viewing: **path**` patterns. Skips empty files and warmup/sidechain sessions (`isSidechain: true` or first message is "Warmup"). Migrated sessions default to `status: "done"`.
- **Ongoing** (`ChatSession.persistSession()`): After each chat completes, upserts the session entry with current model, message count, `updatedAt`, and merges file paths from `activeFile`, `mentionedFiles`, and `relevantNotes`.
- **Manual** (`PATCH /sessions/:id`): Client can update `status` and `title` (used by `/done` command and status toggle in UI).

## Compaction

Long conversations are managed by Hermes. `/compact` is sent through `session/prompt`; the Hermes ACP adapter compresses its session history while keeping the public ACP session UUID stable, then returns a normal assistant message describing the before/after context size. The old compact-boundary renderer remains for transcript backward compatibility, but Hermes does not emit those legacy boundary events.

## Session Management

Sessions are tracked via a central registry file beside the plugin-owned transcript. Hermes' ACP UUID is the durable resume handle used with `session/load`.

**Server endpoints:**
- `GET /sessions?workingDirectory=...&status=...&file=...` — list sessions, sorted by `updatedAt` desc
- `GET /sessions/:sessionId/markers` — list flashcard markers for a session
- `GET /sessions/:sessionId/touched` — list touched vault files (causal working set) for a session. Returns `{ version, entries }` from `{sessionId}.touched.json`.
- `PATCH /sessions/:sessionId` — update `status` and/or `title`
- `DELETE /sessions/:sessionId` — remove session entry and nuke transcript + all sidecars
- `POST /sessions/migrate` — one-time JSONL scan to populate registry

**UI — standalone `SessionsView`** (`src/ui/SessionsView.tsx`): Separate `ItemView` (like `RelevantNotesView`), registered in `main.ts`. Owns its own data fetching, active-file tracking, and migration trigger. Two modes:
- **"This File"** (default) — auto-fetches sessions associated with the active file on `active-leaf-change`
- **"All Sessions"** — shows all sessions vault-wide with status filtering (Active / All)

**Cross-view communication** via custom events (same pattern as RelevantNotes → ChatView):
- `hermes-agent:switch-session` — SessionsView → ChatView (loads history for selected session)
- `hermes-agent:session-changed` — ChatView → SessionsView (sync current session ID)
- `hermes-agent:refresh-sessions` — ChatView → SessionsView (after chat completes, /done, /new)

**Key files:**
- `src/state/sessionState.ts` — Jotai atoms
- `src/ui/SessionsView.tsx` — Standalone ItemView (data fetching + rendering)
- `src/ui/Sessions/SessionCard.tsx` — Card component

## Streaming Input (Message Injection)

Users can send messages while Hermes is actively working. Text messages are sent as `/steer` prompts to the same ACP session; injected images are queued as a normal multimodal follow-up because Hermes only interprets slash commands on text-only prompts.

**WebSocket methods and notifications:**

```
bridge/authenticate  token handshake after WebSocket open
chat/start           start one ACP prompt lifecycle
chat/inject          send /steer or a multimodal follow-up
chat/interrupt       send ACP session/cancel
chat/event           server notification carrying text/tool/result/done events
```

**Server-side flow:**
1. `HermesBridge` authenticates the socket and creates a `ChatSession` for `chat/start`.
2. `ChatSession` opens or loads the Hermes ACP session and calls `session/prompt`.
3. ACP `session/update` notifications become `chat/event` WebSocket notifications.
4. `chat/inject` and `chat/interrupt` address the active chat in that connection's map.
5. Completion writes transcript/registry/marker/touched-note data, emits `done`, and removes the chat.

**Client-side flow:**
1. `HermesAgentClient` keeps one authenticated WebSocket and correlates JSON-RPC responses by numeric request ID.
2. `chat()` creates an async event queue, sends `chat/start`, and yields `chat/event` notifications to `ChatView`.
3. `ChatView.handleSend()` checks `isChatActive()` and calls `injectMessage()` for steering.
4. User messages appear immediately; injection status remains in `messageQueueState`.
5. `isStreamingAtom` controls the stop button and clears on `result`/`done`.

**Turn lifecycle with streaming input:** the ACP `session/prompt` response remains the turn-complete signal. The bridge emits `result`, performs persistence, then emits `done`; the WebSocket remains open for later turns.

**Stop button:** Replaces the send button in `ChatInput` when `isStreaming && !input.trim()`. When user types text, the send button reappears (to submit the injection). Uses a ref callback for the send icon to survive conditional remounting.

**Key files:**
- `server/hermesAcpClient.js` — ACP subprocess, JSON-RPC demux, session update routing, permissions, cancellation
- `server/hermesBridge.js` — WebSocket RPC dispatch and active-chat ownership
- `server/chatSession.js` — chat lifecycle, steering, interruption, and persistence
- `src/hermes/client.ts` — socket lifecycle, request correlation, `injectMessage()`, `interrupt()`, `isChatActive()`
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
    window "hermes-agent:explain-flashcard" { question, answer, context, cardId, sourceFile }
  → Hermes Agent (main.ts handleExplainFlashcard):
    1. resolveFlashcardSession(epoch) — GET /sessions?type=flashcard_study&epoch=today&status=in_progress
    2. Dedup: fetchMarkers(sessionId), if cardId match → scroll to existing marker, return
    3. Switch to daily session (or clear for new), dispatch "hermes-agent:send-message"
  → Hermes bridge (`chatSession.js` completion):
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
| `server/chatSession.js` | Marker writing at chat completion, uses `countUserOnlyMessages` for userMessageIndex |
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

The chat view header displays the session title (or "New Chat" / "Flashcard Study · date"). The title is resolved from the session registry via a `useEffect` that depends on `sessionId`, `plugin.hermesClient`, and a `sessionRefreshTrigger` counter. The counter is bumped by a `hermes-agent:refresh-sessions` event listener, which fires after chat completion, `/rename`, `/done`, etc. — ensuring the header stays in sync with server-side title changes without requiring a `sessionId` change.
