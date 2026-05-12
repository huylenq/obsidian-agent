# System: Claude Agent for Obsidian

## Purpose

An Obsidian plugin that lets the user chat with their vault via Claude Agent SDK. The SDK can't run inside Obsidian's renderer (Node.js APIs missing), so the plugin ships with a sidecar Express proxy that hosts the SDK and exposes HTTP/SSE endpoints. The plugin's React UI talks to the proxy; the proxy talks to the SDK; the SDK reaches the file system and MCP tools.

Two surfaces share the same proxy: a chat-thread UI (with persistent sessions, slash commands, mid-stream message injection, compact boundaries) and a vault-aware retrieval stack (semantic embeddings of vault notes, similarity-based relevant-notes panel, force-directed semantic graph).

Desktop is the primary target; mobile is supported by pointing the same plugin at a remote proxy over an ngrok tunnel.

## Glossary

- **Proxy server** — the Express app under `server/` that hosts the Claude Agent SDK and exposes HTTP/SSE endpoints. The plugin in the Obsidian renderer never calls the SDK directly. On desktop in local mode it is auto-spawned as a child process on `localhost:27182`; on mobile it must be remote.
- **Plugin** — the Obsidian-side code under `src/`. React UI, Jotai state, four `ItemView`s, and `ClaudeAgentClient` (the HTTP client to the proxy).
- **Session** — one chat thread. SDK-assigned UUID. Backed by a JSONL transcript at `~/.claude/projects/{encoded-path}/{sessionId}.jsonl` plus our own sidecar files. Has a `status` (`in_progress` / `done`), a `model`, a `title`, and a list of associated files. <!-- TODO: confirm "associated files" is still the right concept after touched-notes -->
- **Session registry** — `session-registry.json` under the same project folder. Single JSON file indexing all sessions with metadata. The canonical list — backfilled by `/sessions/migrate` from JSONL scans, updated on every `/chat` completion, mutable via `PATCH /sessions/:id`.
- **Transcript** — the SDK-owned JSONL file for a session. One JSON object per line: `user`, `assistant`, `system` entries. The proxy reads transcripts but does not write them — that's the SDK's job.
- **Sidecar file** — a JSON file *we* write next to the SDK transcript: `.summaries.json` (compact summaries), `.markers.json` (flashcard markers), `.touched.json` (touched notes). All live under `~/.claude/projects/{encoded-path}/` and key off the same `sessionId`. The SDK ignores them.
- **Query / queryId** — one streaming SDK invocation. The proxy registers each active query in `queryRegistry.js` keyed by `queryId`, exposing `/chat/:queryId/inject` and `/chat/:queryId/interrupt` for the lifetime of the stream. Distinct from `sessionId` — one session has many queries over time, but typically one active query at a time.
- **Streaming input / message injection** — the user can send a second message while the agent is still producing the first response. The proxy pushes the new message into an `AsyncIterableController` that the SDK is consuming, so the SDK processes it as a follow-up turn without closing the stream.
- **Compact boundary** — a marker the SDK emits when it summarizes long context internally. The proxy generates its own *synthetic summary* with a throwaway Haiku call and persists it to the `.summaries.json` sidecar. The UI renders compact boundaries as collapsible dividers.
- **Synthetic summary** — the Haiku-generated summary stored in `.summaries.json`. Distinct from the SDK's own post-compaction synthetic user message (captured separately as `sdkSummary`).
- **Slash command** — registered in `src/commands/builtins/`. Triggered by typing `/` in chat input. Built-ins: `/new`, `/compact`, `/done`, `/rename`, `/sessions`. `/compact` routes through the chat pipeline; the rest are local UI commands.
- **Touched notes** — the *causal* working set of vault files for a session: every path the agent actually Read / Wrote / Edited via SDK tool blocks. Recorded in `{sessionId}.touched.json`. Deduped by path; latest op wins (Edit-after-Read promotes the entry to `edit`). Distinct from Relevant Notes (similarity-based) — answers "which notes did the agent actually touch?", a stronger working-context signal.
- **Relevant Notes** — similarity-based ranking of vault notes against the active file's embedding (or, planned, the chat context). 70% semantic similarity + 30% link-graph weight using Obsidian's `metadataCache`. Owns its own `ItemView`. Distinct from Touched Notes.
- **Vector index** — self-owned LanceDB index at `<vault>/.obsidian/lance/`. Notes chunked by heading (~6000 chars), embedded via OpenAI `text-embedding-3-small` (1536 dims), incrementally updated on startup by mtime. Served via REST endpoints under `/index/*`.
- **Chunker** — heading-aware markdown chunker in `server/embeddings/chunker.js`. Boundaries follow heading structure rather than fixed token windows.
- **Semantic graph** — force-directed graph of vault notes around a center node, combining wiki-link edges and similarity edges. Own `ItemView`. Pinnable nodes persist across center changes.
- **Connection mode** — `local` (desktop, auto-spawn proxy as child process) or `remote` (desktop or mobile, point at external URL with Bearer auth). Resolved by `getConnectionConfig()` in `src/main.ts`.
- **Connection file** — `claude-agent-connection.json` at vault root. Mobile auto-discovery: written by `scripts/start-mobile-server.sh` on the Mac, syncs via iCloud, read by the plugin on mobile before falling back to manual settings. `{ url, authToken, timestamp }`; entries older than 24h are rejected.
- **Auth token** — `settings.remoteAuthToken`. Double-duty by design: in local mode it's passed as `AUTH_TOKEN` env var to the spawned proxy; in remote mode it's the `Authorization: Bearer` header value on all requests.
- **Active file** — the note the user is currently viewing in Obsidian. Sent with each `/chat` request as `activeFile`, also published into the workspace event system so views like Relevant Notes can react.
- **@mention** — `@filename` syntax in chat input that resolves to a vault file and attaches its content as context. Implemented by `MentionAutocomplete.tsx` + `fileSearch.ts`.
- **Selection context** — when the user has text selected in an editor, the chat input auto-includes the selected text with `{ text, filePath, fileName, startLine, endLine }`.
- **Flashcard explain** — cross-plugin integration with `inline-flashcards`. An Anki deeplink triggers a "explain this flashcard" message into a daily flashcard-study session, with per-card markers for navigation. Tagged sessions have `type: "flashcard_study"` and `epoch: "YYYY-MM-DD"`.
- **Marker** — a flashcard explanation's position in a session: `{ markerId, flashcardId, sourceFile, question, userMessageIndex }`. Stored in `.markers.json`. Lets the UI scroll to an existing explanation instead of duplicating it.

## Bounded contexts

This project is small enough that all contexts share a single `system.md`. Domain Views may be promoted later if any one context grows distinct vocabulary worth a partition.

### Chat & Sessions

Owns: the chat surface, the sessions surface, all slash commands, the session registry and lifecycle, streaming input / interrupt, compact boundaries, the JSONL/sidecar storage layer.

Code: `server/routes/chat.js`, `history.js`, `sessions.js`; `server/sessions.js`, `transcript.js`, `markers.js`, `touchedNotes.js`, `queryRegistry.js`, `asyncIterableController.js`; `src/ui/ChatView.tsx`, `SessionsView.tsx`, `ChatInput.tsx`, `ChatMessages.tsx`; `src/state/chatState.ts`, `sessionState.ts`, `messageQueueState.ts`; `src/commands/`.

### Embeddings & Retrieval

Owns: the LanceDB index, vault scanning, chunking, embedding, the `/index/*` REST surface, and the client-side ranking & display of relevant notes.

Code: `server/embeddings/`, `server/routes/index.js`; `src/embeddings/`, `src/ui/RelevantNotes/`, `RelevantNotesView.tsx`; `src/state/relevantNotesState.ts`.

### Semantic Graph

Owns: graph data construction (combining `app.metadataCache` link edges with similarity edges from the index), the force-directed layout, the graph surface UI, and pinned-node persistence.

Code: `src/graph/`, `src/ui/GraphView/`, `src/ui/GraphView.tsx`; `src/state/graphViewState.ts`.

### Connection & Transport

Owns: deciding *how* the plugin reaches the proxy (auto-spawn vs remote URL), the auth-token double-duty, mobile auto-discovery via the connection file, and the connection-status UI.

Code: `src/main.ts` (`getConnectionConfig`, `initializeClient`); `src/claude/client.ts`; `src/state/connectionState.ts`; `src/settings.ts` (Connection section); `server/index.js`, `server/middleware/auth.js`; `scripts/start-mobile-server.sh` (lives in the vault, not the repo).

### Flashcard integration

Owns: the cross-plugin event protocol (`claude-agent:explain-flashcard`, `flashcard:navigate`, `claude-agent:send-message`), daily flashcard-study session resolution, marker writing and dedup, and the styled flashcard-explain bubble in chat.

Code: `src/main.ts` (`handleExplainFlashcard`); `server/markers.js`; marker-writing block in `server/routes/chat.js`; marker injection in `server/routes/history.js`; `parseFlashcardContent()` in `src/ui/ChatMessages.tsx`. Counterparty: `../inline-flashcards/main.ts`.

### Boundary rules

- **The plugin never imports `@anthropic-ai/claude-agent-sdk` directly.** All SDK access goes through the proxy over HTTP/SSE. (Renderer doesn't have Node.js builtins; this is non-negotiable, not a stylistic preference.)
- **The proxy is the only writer of session sidecar files.** Plugin code reads sidecars indirectly via API endpoints (`GET /sessions/:id/markers`, `GET /sessions/:id/touched`), never via direct filesystem access.
- **Transcripts (`.jsonl`) are SDK-owned, read-only to us.** All session metadata we want to add lives in sidecars, never in the JSONL.
- **The connection file is treated as untrusted-but-trusted-enough:** rejected if >24h old; otherwise honored. The vault is the trust root.
- **Cross-plugin events use the `claude-agent:` prefix outgoing and listen for `flashcard:` incoming.** Don't introduce new prefixes; don't tunnel data through other plugin's event names.

## Invariants

- **`countUserOnlyMessages()` ↔ `history.js` user-message counting must stay in sync.** <!-- TODO: confirm still holds --> Marker `userMessageIndex` is computed by the former at write time and re-resolved by the latter at history-load time. If `history.js` adds new skip conditions (e.g. filtering `/compact` commands), `countUserOnlyMessages` must update to match. Both currently exclude `toolUseResult` entries.
- **Local mode requires Node.js; mobile cannot run local.** `isDesktopOnly: false` in `manifest.json`; Node builtins (`child_process`, `path`) are imported with try-catch guards in `main.ts`; `deploy.js` skips copying `server/` to `.obsidian-mobile`.
- **Auth token is symmetric across modes.** Whatever `remoteAuthToken` is set to: in local mode it becomes `AUTH_TOKEN` env on the spawned process; in remote mode it becomes the `Authorization: Bearer` header. There is no separate "local token" / "remote token" — same secret, same name on the wire.
- **Touched-notes dedup: latest op wins.** Within a session, repeated touches to the same path collapse to one entry; if a path is Read then later Edited, the entry promotes from `read` to `edit`. The `count` is the total number of touches across any op.
- **Compact summaries use a throwaway cwd.** Synthetic-summary generation uses `/tmp/claude-agent-compact-summaries` as the SDK cwd specifically to avoid polluting the main project's `~/.claude/projects/{encoded-path}/` with summarization sessions.
- **Pre-publication blocker: OpenAI key is a hard requirement.** The plugin currently demands an `openaiApiKey` for vault indexing, blocking it from being a no-config community-store plugin. <!-- TODO: confirm still planned to address per project_publishability memory -->

## Architecture seams

- **The HTTP/SSE bridge between plugin and proxy.** The single biggest seam. SSE flows server → client (streaming responses, `session`, `result`, `compact_boundary`, `done`). HTTP POST flows client → server for control (`/chat`, `/chat/:queryId/inject`, `/chat/:queryId/interrupt`, `/sessions/*`, `/history`, `/index/*`). Changes that affect both sides — new event types, new endpoints, new fields on existing payloads — need to land in lockstep.
- **The `IIndexClient` interface (`src/embeddings/IIndexClient.ts`).** Plugin-side abstraction over the vector index. Currently only `AgentIndexClient` (HTTP to the proxy's LanceDB), but the interface exists so an in-process or alternative backend could slot in.
- **SDK-managed JSONL vs our sidecar JSON.** The line between what the SDK owns (transcripts) and what we own (`.summaries.json`, `.markers.json`, `.touched.json`, `session-registry.json`). Crossing this line — e.g. trying to read SDK internals from a transcript — is a smell.
- **Cross-plugin event bus.** The agent ↔ inline-flashcards integration runs over `window.dispatchEvent`. Loosely coupled by design: each side degrades gracefully if the other is not loaded.
- **The `claude-agent-connection.json` discovery file at vault root.** Acts as a side-channel between the Mac (proxy host) and the mobile device (proxy client) over iCloud sync. Cheap, no extra infra, but it makes the vault filesystem part of the trust model.

## Decisions worth knowing

No ADRs migrated from existing docs — this project doesn't have a formal decision log. Notable implicit decisions captured in CLAUDE.md and now folded into invariants / glossary above:

- Proxy-server architecture chosen over attempting SDK-in-renderer. <!-- TODO: candidate ADR-0001 -->
- LanceDB chosen over Orama (renamed in commit 7439e37). <!-- TODO: candidate ADR-0002, capture the why -->
- Self-owned vault index rather than reusing Copilot's index. <!-- TODO: confirm — see OPENCLAW_REPLICATION_PLAN.md "reuse Copilot index" suggestion that was *not* taken -->
- Cross-plugin integration via window events rather than a shared module / API. <!-- TODO: candidate ADR-0003 -->

## Things deliberately not specified

- **Identity / Soul / Memory layer.** OpenClaw-style `SOUL.md` / `USER.md` / `MEMORY.md` bootstrap and memory-search tooling are described in `OPENCLAW_REPLICATION_PLAN.md` but **not implemented**. Either pick it up as a feature (move plan into `lexicon/plans/`) or archive the doc.
- **Authentication beyond the static Bearer token.** No JWT, no rotation, no per-user scoping. The proxy is a single-tenant local-or-tunneled service.
- **Multi-vault.** The proxy assumes one `workingDirectory` per run. Multi-vault would require either multiple proxies or per-request vault routing — neither is built.
- **Plan / agent-mode toggles.** The plugin runs the agent in its default streaming mode. No plan-mode UI, no permission-prompt UI, no model-output gating.
- **Multi-agent / sub-agents.** Single-agent only. No routing, no specialist personas.
