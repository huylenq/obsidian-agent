# System: Hermes Agent for Obsidian

## Purpose

An Obsidian plugin that lets the user chat with their vault via Hermes Agent over ACP. A sidecar Hermes bridge owns one long-lived `hermes acp` subprocess. The plugin uses one bidirectional WebSocket for chat and HTTP support APIs for health, indexing, history, and session metadata. Hermes owns model context, tools, MCP servers, rules, skills, and memory.

Two surfaces share the same bridge: a chat-thread UI (with persistent sessions, slash commands, mid-stream steering, and cancellation) and a vault-aware retrieval stack (semantic embeddings of vault notes, similarity-based relevant-notes panel, force-directed semantic graph).

Desktop is the primary target; mobile is supported by pointing the same plugin at a remote bridge over an ngrok tunnel.

## Glossary

- **Hermes bridge** — the sidecar under `server/` that owns `hermes acp`, exposes `/bridge` over WebSocket, and serves the HTTP support APIs. On desktop in local mode it is auto-spawned on `localhost:27182`; on mobile it must be remote.
- **Plugin** — the Obsidian-side code under `src/`. React UI, Jotai state, four `ItemView`s, and `HermesAgentClient` (WebSocket chat plus HTTP support calls).
- **Session** — one chat thread. Hermes-assigned ACP UUID, resumed with `session/load`. Backed for display by a bridge-owned JSONL transcript at `~/.hermes/obsidian-agent/projects/{encoded-path}/{sessionId}.jsonl` plus sidecar files; Hermes' session DB is the model-context source of truth. Has a `status` (`in_progress` / `done`), a `model` label, a `title`, and associated files (`activeFile`, `mentionedFiles`, and `relevantNotes` merged across turns — distinct from touched notes).
- **Session registry** — `session-registry.json` under the same project folder. Single JSON file indexing all sessions with metadata. The canonical list — backfilled by `/sessions/migrate`, updated on every bridge chat completion, mutable via `PATCH /sessions/:id`.
- **Transcript** — the bridge-owned JSONL display projection of ACP user, assistant, and tool events. It supports the existing history UI but is not fed back to the model.
- **Sidecar file** — a JSON file next to the display transcript: `.markers.json` (flashcard markers) or `.touched.json` (touched notes). All live under `~/.hermes/obsidian-agent/projects/{encoded-path}/` and key off the ACP `sessionId`.
- **Bridge chat / chatId** — one `chat/start` lifecycle on the WebSocket. The bridge keeps active chats in the owning connection until persistence and `done` complete. Distinct from `sessionId`: one Hermes session has many chats over time.
- **Streaming input / message injection** — the user can send a second text message while Hermes is still working. The bridge sends it as `/steer` in a concurrent ACP `session/prompt`; injected images become a queued multimodal follow-up.
- **Slash command** — registered in `src/commands/builtins/`. Triggered by typing `/` in chat input. Built-ins: `/new`, `/compact`, `/done`, `/rename`, `/sessions`. `/compact` routes through the chat pipeline; the rest are local UI commands.
- **Touched notes** — the *causal* working set of vault files for a session: every path Hermes actually reads, writes, or edits as reported by ACP tool-call locations. Recorded in `{sessionId}.touched.json`. Deduped by path; latest op wins. Distinct from Relevant Notes (similarity-based).
- **Relevant Notes** — similarity-based ranking of vault notes against the active file's embedding (or, planned, the chat context). 70% semantic similarity + 30% link-graph weight using Obsidian's `metadataCache`. Owns its own `ItemView`. Distinct from Touched Notes.
- **Vector index** — self-owned LanceDB index at `<vault>/.obsidian/lance/`. Notes chunked by heading (~6000 chars), embedded via OpenAI `text-embedding-3-small` (1536 dims), incrementally updated on startup by mtime. Served via REST endpoints under `/index/*`.
- **Chunker** — heading-aware markdown chunker in `server/embeddings/chunker.js`. Boundaries follow heading structure rather than fixed token windows.
- **Semantic graph** — force-directed graph of vault notes around a center node, combining wiki-link edges and similarity edges. Own `ItemView`. Pinnable nodes persist across center changes.
- **Connection mode** — `local` (desktop, auto-spawn bridge) or `remote` (desktop or mobile, point at an external bridge URL). Resolved by `getConnectionConfig()` in `src/main.ts`.
- **Connection file** — `hermes-agent-connection.json` at vault root. Mobile auto-discovery: written by `scripts/start-mobile-server.sh`, synced via iCloud, and read before manual settings. Shape: `{ url, timestamp }`; the former filename remains an upgrade alias.
- **Auth token** — `settings.remoteAuthToken`. In local mode it becomes `AUTH_TOKEN` for the bridge process; the client sends it in `bridge/authenticate` and as an HTTP Bearer token for protected support APIs.
- **Active file** — the note currently viewed in Obsidian. Sent in the `chat/start` request and published into the workspace event system so views like Relevant Notes can react.
- **@mention** — `@filename` syntax in chat input that resolves to a vault file and attaches its content as context. Implemented by `MentionAutocomplete.tsx` + `fileSearch.ts`.
- **Selection context** — when the user has text selected in an editor, the chat input auto-includes the selected text with `{ text, filePath, fileName, startLine, endLine }`.
- **Flashcard explain** — cross-plugin integration with `inline-flashcards`. An Anki deeplink triggers a "explain this flashcard" message into a daily flashcard-study session, with per-card markers for navigation. Tagged sessions have `type: "flashcard_study"` and `epoch: "YYYY-MM-DD"`.
- **Marker** — a flashcard explanation's position in a session: `{ markerId, flashcardId, sourceFile, question, userMessageIndex }`. Stored in `.markers.json`. Lets the UI scroll to an existing explanation instead of duplicating it.

## Bounded contexts

This project is small enough that all contexts share a single `system.md`. Domain Views may be promoted later if any one context grows distinct vocabulary worth a partition.

### Chat & Sessions

Owns: the chat surface, the sessions surface, all slash commands, the session registry and lifecycle, ACP steering/cancellation, and the JSONL/sidecar display-storage layer.

Code: `server/hermesBridge.js`, `chatSession.js`, `hermesAcpClient.js`; `server/routes/history.js`, `routes/sessions.js`; `server/sessions.js`, `transcript.js`, `storage.js`, `markers.js`, `touchedNotes.js`; `src/hermes/client.ts`; `src/ui/ChatView.tsx`, `SessionsView.tsx`, `ChatInput.tsx`, `ChatMessages.tsx`; `src/state/chatState.ts`, `sessionState.ts`, `messageQueueState.ts`; `src/commands/`.

### Embeddings & Retrieval

Owns: the LanceDB index, vault scanning, chunking, embedding, the `/index/*` REST surface, and the client-side ranking & display of relevant notes.

Code: `server/embeddings/`, `server/routes/index.js`; `src/embeddings/`, `src/ui/RelevantNotes/`, `RelevantNotesView.tsx`; `src/state/relevantNotesState.ts`.

### Semantic Graph

Owns: graph data construction (combining `app.metadataCache` link edges with similarity edges from the index), the force-directed layout, the graph surface UI, and pinned-node persistence.

Code: `src/graph/`, `src/ui/GraphView/`, `src/ui/GraphView.tsx`; `src/state/graphViewState.ts`.

### Connection & Transport

Owns: deciding *how* the plugin reaches the bridge (auto-spawn vs remote URL), the auth-token double-duty, mobile auto-discovery via the connection file, and the connection-status UI.

Code: `src/main.ts` (`getConnectionConfig`, `initializeClient`); `src/hermes/client.ts`; `src/state/connectionState.ts`; `src/settings.ts` (Connection section); `server/index.js`, `server/middleware/auth.js`; `scripts/start-mobile-server.sh` (lives in the vault, not the repo).

### Flashcard integration

Owns: the cross-plugin event protocol (`hermes-agent:explain-flashcard`, `flashcard:navigate`, `hermes-agent:send-message`), daily flashcard-study session resolution, marker writing and dedup, and the styled flashcard-explain bubble in chat.

Code: `src/main.ts` (`handleExplainFlashcard`); `server/markers.js`; marker writing in `server/chatSession.js`; marker injection in `server/routes/history.js`; `parseFlashcardContent()` in `src/ui/ChatMessages.tsx`. Counterparty: `../inline-flashcards/main.ts`.

### Boundary rules

- **Only the bridge speaks ACP.** The renderer uses WebSocket/HTTP; `server/hermesAcpClient.js` alone owns the newline-delimited JSON-RPC subprocess transport.
- **The bridge is the only writer of session sidecar files.** Plugin code reads sidecars indirectly via API endpoints (`GET /sessions/:id/markers`, `GET /sessions/:id/touched`), never via direct filesystem access.
- **Hermes' session DB owns model context; the display JSONL owns UI history.** Never claim the display transcript is sufficient to resume a model conversation. ACP `session/load` is the resume path.
- **Chat control stays on one socket.** Start, streaming updates, steering, and cancellation must not grow separate HTTP routes again.
- **Cross-plugin events use the `hermes-agent:` prefix outgoing and listen for `flashcard:` incoming.** Don't introduce new prefixes; don't tunnel data through other plugin's event names.
- **Pre-ACP identifiers are compatibility data, not current domain names.** Keep them isolated in `src/legacy.ts` (plus the persisted manifest/deploy id and the legacy CSS view selector); new code uses Hermes names.

## Invariants

- **`countUserOnlyMessages()` ↔ `history.js` user-message counting must stay in sync.** Marker `userMessageIndex` is computed by the former at write time and re-resolved by the latter at history-load time. If `history.js` adds new skip conditions (e.g. filtering `/compact` commands), `countUserOnlyMessages` must update to match. Both currently exclude `toolUseResult` entries (`server/sessions.js:178`, `server/routes/history.js:114`).
- **Local mode requires Node.js; mobile cannot run local.** `isDesktopOnly: false` in `manifest.json`; Node builtins (`child_process`, `path`) are imported with try-catch guards in `main.ts`; `deploy.js` skips copying `server/` to `.obsidian-mobile`.
- **Auth token is symmetric across transports.** `remoteAuthToken` becomes `AUTH_TOKEN` locally, the WebSocket authentication value, and the HTTP Bearer token. There is no separate local/remote secret.
- **Touched-notes dedup: latest op wins.** Within a session, repeated touches to the same path collapse to one entry; if a path is Read then later Edited, the entry promotes from `read` to `edit`. The `count` is the total number of touches across any op.
- **ACP permissions preserve the old autonomy contract.** The bridge selects the broadest allow option offered by Hermes because the replaced SDK integration used `bypassPermissions`. Changing this requires an explicit UI permission flow.
## Architecture seams

- **The WebSocket bridge contract.** `bridge/authenticate`, `chat/start`, `chat/inject`, and `chat/interrupt` are JSON-RPC-style requests; `chat/event` carries streamed updates. Contract changes must land in `server/hermesBridge.js` and `src/hermes/client.ts` together.
- **The `IIndexClient` interface (`src/embeddings/IIndexClient.ts`).** Plugin-side abstraction over the vector index. Currently only `AgentIndexClient` (HTTP to the bridge's LanceDB), but the interface exists so an in-process or alternative backend could slot in.
- **Hermes session DB vs our display storage.** Hermes owns conversation state and ACP resume. The bridge owns `.jsonl`, `.markers.json`, `.touched.json`, and `session-registry.json` for UI concerns. Crossing those responsibilities is a smell.
- **Cross-plugin event bus.** The agent ↔ inline-flashcards integration runs over `window.dispatchEvent`. Loosely coupled by design: each side degrades gracefully if the other is not loaded.
- **The `hermes-agent-connection.json` discovery file at vault root.** Acts as a side-channel between the Mac (bridge host) and mobile over iCloud sync. Cheap, no extra infra, but it makes the vault filesystem part of the trust model.

## Design system

The plugin is host-embedded in Obsidian. It owns no token system and no renderer — both are inherited from the host. The design vocabulary that *is* owned by this plugin lives in the surface/region names below, a small set of bespoke components under `src/ui/`, and the cross-cutting visual patterns (cards, chips, toolbar, tool block, compact boundary).

### Tokens (inherited from Obsidian)

All visual constants are Obsidian CSS custom properties. The plugin does not declare its own theme.

- Color: `--background-primary`, `--background-secondary`, `--background-secondary-alt`, `--background-modifier-border`, `--background-modifier-hover`, `--background-modifier-error`, `--text-normal`, `--text-muted`, `--text-faint`, `--text-accent`, `--text-error`, `--text-on-accent`, `--interactive-accent`, `--color-green`, `--color-orange`.
- Type: `--font-text`, `--font-monospace`, `--font-ui-small`, `--font-ui-smaller`.
- Layering: `--layer-popover`.

Hex literals or hardcoded pixel sizes outside the spacing scale are a token-discipline drift signal. Plugin-owned stylesheets live in `src/styles/`, one file per area (`layout`, `input`, `messages`, `relevant-notes`, `sessions`, `graph-view`, `mention`, `context-chips`, `toolBlockPkm`, `diagrams`), bundled via `index.css`.

### Surfaces & regions

Four top-level surfaces, each an Obsidian `ItemView` registered in `src/main.ts`:

- **Chat** (`CHAT_VIEW_TYPE`) — *Component*: `HermesAgentChatView` (`src/ui/ChatView.tsx`). The chat-thread surface.
  - **Session header** — *Inline*: `ChatView.tsx`. Title, session-id chip with copy, new-chat / done / view-location buttons. Click-to-open dropdown trigger.
  - **Session dropdown** — *Inline*: `ChatView.tsx`. Search input + result list, mounted from the header.
  - **Messages list** — *Component*: `ChatMessages` (`src/ui/ChatMessages.tsx`). Renders user/assistant bubbles, tool groups, compact boundaries, flashcard-explain cards.
  - **Input area** — *Inline*: `ChatView.tsx`. Wraps the next three regions.
    - **Context chips row** — *Inline*: `ChatView.tsx`. Hosts `ActiveFileChip` and `SelectionChip`.
    - **Composer** — *Component*: `ChatInput` (`src/ui/ChatInput.tsx`). Text field, drag-drop image previews, interrupt/send button, embedded autocompletes.
    - **Input footer** — *Inline*: `ChatView.tsx`. Model select, include-relevant-notes toggle, attach button, connection-status dot.
- **Sessions** (`SESSIONS_VIEW_TYPE`) — *Component*: `SessionsView` (`src/ui/SessionsView.tsx`).
  - **Sessions toolbar** — *Inline*: `SessionsView.tsx`. Mode toggle (This File / All Sessions), status filter, refresh / migrate icons.
  - **Sessions list** — *Inline*: `SessionsView.tsx`. Stack of `SessionCard`s, plus empty/error states.
- **Relevant Notes** (`RELEVANT_NOTES_VIEW_TYPE`) — *Component*: `RelevantNotesView` (`src/ui/RelevantNotesView.tsx`).
  - **Relevant-notes toolbar** — *Inline*: `RelevantNotesView.tsx`. Mode toggle and filters.
  - **Relevant-notes list** — *Inline*: `RelevantNotesView.tsx`. Stack of `RelevantNoteCard`s.
- **Semantic Graph** (`GRAPH_VIEW_TYPE`) — *Component*: `GraphView` (`src/ui/GraphView.tsx`).
  - **Graph canvas** — *Component*: `GraphCanvas` (`src/ui/GraphView/GraphCanvas.tsx`).
  - **Graph controls** — *Component*: `GraphControls` (`src/ui/GraphView/GraphControls.tsx`).
  - **Graph tooltip** — *Component*: `GraphTooltip` (`src/ui/GraphView/GraphTooltip.tsx`).

**Relevant Notes has an embedded second life** inside the Chat surface: `RelevantNotes` (`src/ui/RelevantNotes/RelevantNotes.tsx`) is a collapsible inline variant of the standalone view that shares the `RelevantNoteCard` row vocabulary. The toolbar and empty/error states are duplicated between the two paths. See `lexicon/plans/relevant-notes-dedup/spec.md`.

### Component vocabulary

Owned components with broad reach across surfaces:

- **`ChatMessages` / `ChatInput`** — the chat surface's two heaviest children.
- **`ToolCallBlock`** — single-call render (Read / Write / Edit / Bash / …); PKM-aware variants for file-op tools.
- **`ToolGroup`** — collapses sequential tool calls in the stream, with file-op dedup, `LinkArcs`, and an optional embedded `TouchedGraphPanel`.
- **`MarkdownContent`** — shared markdown renderer for message bodies, summaries, and inline cards.
- **`WikilinkPill`** — rendered `[[wikilink]]` chip in chat, expands on hover to show `NoteMetadataStrip`.
- **`NoteMetadataStrip`** — chip row with backlinks count, tags, mtime. Reused under `WikilinkPill` and in tool blocks.
- **`SessionCard` / `RelevantNoteCard`** — list-row components for their respective surfaces.
- **`ActiveFileChip` / `SelectionChip`** — composer context-chip variants.
- **`ResizeHandle`** — draggable height handle on the embedded Relevant-Notes panel.

### Cross-cutting visual patterns

Patterns appearing across surfaces — naming them prevents "same shape, two names" drift:

- **Card** — bordered row with title + meta + optional thumbnail. Instances: `SessionCard`, `RelevantNoteCard`.
- **Chip** — small inline pill. Instances: `ActiveFileChip`, `SelectionChip`, `WikilinkPill`, `NoteMetadataStrip` items.
- **Toolbar** — top strip with mode-toggle buttons + clickable icons. Instances: Sessions toolbar, Relevant-Notes toolbar.
- **Tool block** — collapsible chat-stream frame for tool calls. Owns its own stylesheet (`toolBlockPkm.css`).
- **Compact boundary** — legacy collapsible divider retained by the message renderer for backward-compatible history data. Hermes `/compact` currently returns a normal assistant message instead.
- **Flashcard-explain bubble** — Δ-marked card variant of the user message, triggered by content pattern in `parseFlashcardContent()` (`ChatMessages.tsx`).

### Interaction patterns

- **`@mention`** in the composer opens `MentionAutocomplete`, resolving to vault files; selection attaches file content as context.
- **`/`** in the composer opens `CommandAutocomplete` for built-in slash commands.
- **Drag-and-drop** images onto the composer attaches them as image inputs.
- **Cross-plugin window events** carry agent ↔ inline-flashcards navigation (`flashcard:navigate`, `hermes-agent:explain-flashcard`, `hermes-agent:send-message`). Both sides degrade gracefully if the counterparty is absent.

## Decisions worth knowing

- **ADR-0001: Sidecar bridge architecture** — why a sidecar owns agent transport and why chat now uses one WebSocket instead of HTTP/SSE.
- **ADR-0002: Self-owned LanceDB vector index** — why the plugin runs its own embedding/indexing stack instead of depending on a peer plugin.
- **ADR-0003: Cross-plugin window events** — why the agent ↔ inline-flashcards integration runs over DOM events instead of a shared API.

## Things deliberately not specified

- **Community-store publication.** The plugin is consciously *shareable-but-unofficial*. Several traits would block community-store acceptance — sidecar Node.js server, an external Hermes CLI/runtime requirement, no in-plugin Hermes credential management, hardcoded paths tied to one setup, and a non-semver manifest version. None of these are being actively addressed; the README disclaimer is the chosen response.
- **Identity / Soul / Memory layer.** OpenClaw-style `SOUL.md` / `USER.md` / `MEMORY.md` bootstrap and memory-search tooling are described in `OPENCLAW_REPLICATION_PLAN.md` but **not implemented**. Either pick it up as a feature (move plan into `lexicon/plans/`) or archive the doc.
- **Authentication beyond the static Bearer token.** No JWT, no rotation, no per-user scoping. The bridge is a single-tenant local-or-tunneled service.
- **Multi-vault.** The bridge assumes one `workingDirectory` per run. Multi-vault would require multiple bridges or explicit per-connection vault routing — neither is built.
- **Plan / agent-mode toggles.** The plugin runs the agent in its default streaming mode. No plan-mode UI, no permission-prompt UI, no model-output gating.
- **Multi-agent / sub-agents.** Single-agent only. No routing, no specialist personas.
