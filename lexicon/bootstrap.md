# Bootstrap report

Run on: 2026-05-12

## What was created

- `lexicon/system.md` (drafted; 112 lines, 6 `<!-- TODO -->` markers)
- `lexicon/decisions/` — empty (no existing ADRs to migrate)
- `lexicon/retros/`, `lexicon/audits/`, `lexicon/plans/_archive/` — empty, ready to populate
- No Domain Views created — project is moderate-sized with closely-coupled contexts. Promote to views later if `system.md` grows past ~500 lines or a single context develops distinct vocabulary.

## Doc audit summary

- 5 existing docs scanned (excluding `README.md`)
- Bucketed: cold-layer-candidates=1 (`CLAUDE.md` — heavy), adr-like=0, hot-feature=1 (`OPENCLAW_REPLICATION_PLAN.md`), reference=2 (`README.md`, `docs/ios-keyboard-problem-analysis.md`), stale=1 (`WORKLOG.md`)

`CLAUDE.md` was the primary distillation source — it's basically already a system doc, just hot-formatted as instructions to Claude. Most of the drafted `system.md` is a structural re-shaping of content that was already there.

## Glossary candidates with strong evidence

All of the following appear in both `CLAUDE.md` prose and as code identifiers / file names / endpoints. Each landed in `system.md`'s glossary:

- **Proxy server** — `server/index.js`, `server/middleware/auth.js`; CLAUDE.md "Why a proxy?" section
- **Session** — `sessionId` everywhere in server code; `SessionEntry` type in `src/types.ts`
- **Session registry** — `session-registry.json`; `updateSessionEntry()` in `server/sessions.js`
- **Transcript** — `transcript.js`, JSONL files in `~/.claude/projects/.../`
- **Query / queryId** — `server/queryRegistry.js`, `/chat/:queryId/inject` endpoint
- **AsyncIterableController / streaming input** — `server/asyncIterableController.js`, `ChatInput.tsx` stop-button logic
- **Compact boundary / synthetic summary** — `compact_boundary` literal in `server/routes/history.js`, `.summaries.json` sidecar
- **Slash command** — `src/commands/builtins/`
- **Touched notes** — `server/touchedNotes.js`, `{sessionId}.touched.json` sidecar
- **Relevant Notes** — `src/embeddings/search.ts`, `src/ui/RelevantNotes/`
- **Vector index / LanceDB** — `server/embeddings/lanceIndex.js`, `.obsidian/lance/`
- **Semantic graph** — `src/graph/`, `src/ui/GraphView/`
- **Connection mode** — `ConnectionMode` type, `getConnectionConfig()` in `main.ts`
- **Connection file** — `claude-agent-connection.json`
- **Auth token** — `settings.remoteAuthToken`, `AUTH_TOKEN` env var
- **Active file** — `activeFile` field on `/chat` requests, `ActiveFileContext` type
- **@mention / selection context** — `MentionAutocomplete.tsx`, `SelectionContext` type
- **Flashcard explain / marker** — `server/markers.js`, `MarkerMetadata` type

## Drift flags (term in docs, missing or renamed in code)

- **None at high confidence.** `CLAUDE.md` is unusually well-aligned with the code — author and editor are the same Claude-assisted feedback loop. One soft signal: `OPENCLAW_REPLICATION_PLAN.md` defines a whole vocabulary (`SOUL.md`, `USER.md`, `MEMORY.md`, `memory_search`, `memory_get`, "soul-evil hook", "bootstrap files") that does *not* appear in code. This is plan-for-unimplemented-feature, not drift — but worth a decision: implement, formally archive, or kill the doc.
- **Untracked working-tree drift:** `src/ui/AppContext.tsx`, `src/ui/LinkArcs.tsx`, `src/ui/TouchedGraphPanel.tsx`, `src/ui/wikilink/` (NoteMetadataStrip, WikilinkPill, noteContent), `src/styles/toolBlockPkm.css` are all uncommitted files NOT mentioned anywhere in `CLAUDE.md`. They look like an in-flight feature ("touched-notes graph panel"? wikilink-pill rendering for tool calls?). If they ship, `CLAUDE.md` and `system.md` will both need updates. Flagging for awareness — bootstrap is not the moment to absorb in-flight work.

## Inconsistencies (same term, different definitions)

- **None found.**

## Invariants extracted (need user confirmation)

- **`countUserOnlyMessages()` ↔ `history.js` user-message counting must stay in sync.** Sourced verbatim from `CLAUDE.md` "Critical invariant" subsection. Still load-bearing as long as marker `userMessageIndex` is used for history annotation.
- **Local mode requires Node.js; mobile cannot run local.** Sourced from `CLAUDE.md` "Connection Modes" + "Mobile constraints".
- **Auth token is symmetric across modes** (same value, two carriers). Sourced from `CLAUDE.md` "Auth token serves double duty".
- **Touched-notes dedup: latest op wins.** Sourced from `CLAUDE.md` "Files we create and manage" table + the matching code path in `server/touchedNotes.js:69-103`.
- **Compact summaries use a throwaway cwd.** Sourced from `CLAUDE.md` "Compaction" section.
- **OpenAI key hard requirement is publishability blocker.** Sourced from `memory/project_publishability.md` — confirm still planned to address.

## Provisional bounded contexts

Five, all in one `system.md`:

- **Chat & Sessions** — chat surface, sessions surface, slash commands, streaming I/O, compact boundaries, sidecar storage
- **Embeddings & Retrieval** — LanceDB index, chunking, embedding, Relevant Notes ranking
- **Semantic Graph** — force-directed graph combining link + similarity edges
- **Connection & Transport** — local-vs-remote, auth-token double-duty, mobile auto-discovery
- **Flashcard integration** — cross-plugin event protocol with `inline-flashcards`

## Rationale ("why" notes) extracted verbatim

- From `CLAUDE.md`: *"Why a proxy? Claude Agent SDK uses Node.js APIs incompatible with Obsidian's Electron environment."*
- From `CLAUDE.md`: *"Throwaway Haiku sessions for summarization use `/tmp/claude-agent-compact-summaries` as cwd to avoid polluting the main project's transcripts."*
- From `CLAUDE.md`: *"The default skips `server/node_modules` to avoid churning iCloud sync with hundreds of unchanged files."*
- From `CLAUDE.md`: *"On mobile, remote mode is the only option — there's no Node.js runtime to run the server."*
- From `CLAUDE.md`: *"Auto-moving feature docs is a high-blast-radius action — they may have URLs, links, or be cited elsewhere. Let the user choose."* (about lex-bootstrap itself — meta, but worth noting it shaped this run's behavior)

These are now scattered through `system.md` as one-line justifications inline with the relevant glossary / invariant entries, rather than collected in a "Rationale" section. If the project develops more why-notes that don't fit a specific entry, a top-level "Rationale" section can be added.

## Design system findings

- No design tokens detected (no `tokens/`, no `tailwind.config.*`, no theme files). Styling is CSS modules under `src/styles/` riding on Obsidian's native CSS variables (`var(--background-primary)`, etc.).
- No formal component library — UI components are colocated in `src/ui/`, imported by relative path.
- No a11y tooling (no `eslint-plugin-jsx-a11y`, no `axe-core`).
- **Surfaces detected:** 4 top-level `ItemView`s — `ClaudeAgentChatView`, `RelevantNotesView`, `SessionsView`, `GraphView`. Registered in `src/main.ts:98-107`.
- Named regions identified: minimal — a handful of `{/* Streaming message */}` style comments in `ChatMessages.tsx:397-419`, plus class-name regions like `.claude-agent-session-header` and `.claude-agent-session-dropdown` in `ChatView.tsx`.

**Conclusion:** the project doesn't have a design system in the lexicon sense. The `## Design system` section was deliberately omitted from `system.md`. If the UI grows formal design tokens or a component library later, add the section then.

## Recommended file moves (NOT done — needs your call)

- **`OPENCLAW_REPLICATION_PLAN.md`** → decide one of three:
  1. Active work: move to `lexicon/plans/openclaw-memory/spec.md` and add the vocabulary (SOUL/USER/MEMORY/memory_search) to `system.md`'s glossary.
  2. Deferred but worth keeping as inspiration: move to `lexicon/plans/_archive/openclaw-memory/spec.md`.
  3. Not happening: delete the doc.

  Don't leave it at repo root — it currently advertises a feature surface the code doesn't have, which is a future drift trap.

- **`WORKLOG.md`** → tiny scratch file ("Realign send message button", "RAG-matched note files"). Two options:
  1. Leave alone — informal backlog is fine outside lexicon.
  2. Migrate to `lexicon/plans/backlog.md` if you want it under the same workflow.

  No strong recommendation either way.

## Possibly stale (your call)

- **`docs/ios-keyboard-problem-analysis.md`** — last touched 2026-02-22, documents a *problem we did not solve*. Useful as engineering-archaeology if mobile keyboard handling comes up again; potentially confusing-on-first-read because it ends with "unexplored approaches" not "fix". Leave as reference; archive if you trip over it.

## Pre-existing memory worth knowing about

`~/.claude/projects/-Users-huy-src-obsidian-agent/memory/MEMORY.md` already has lexicon-adjacent entries:

- **`workflow.md`** — deploy commands and paths. Operational, not cold-layer. Leave in auto-memory; don't migrate.
- **`project_publishability.md`** — blockers for community-store publication. This *is* arguably a project-level invariant ("we're consciously shareable-but-unofficial until X, Y, Z are fixed"). Consider folding into `system.md`'s "Things deliberately not specified" or as its own invariant; I left a TODO marker in `system.md`'s invariants referencing it.

## Next step

Run a focused-distillation session (no other task mixed in) where you walk through `lexicon/system.md` with the agent and:

1. Confirm or revise each `<!-- TODO -->` marker (there are 6).
2. Decide what to do with `OPENCLAW_REPLICATION_PLAN.md` (active / archive / delete).
3. Decide whether the four candidate ADRs in "Decisions worth knowing" deserve to be written up. Highest-value one is probably **ADR-0001: proxy-server architecture** — non-obvious to a future reader and load-bearing on every other design choice.
4. Sanity-check the bounded-context boundaries against your real mental model — especially whether Flashcard integration should stay its own context or fold into Chat & Sessions.
5. Cross-check whether the in-flight untracked work (`AppContext.tsx`, `wikilink/`, `TouchedGraphPanel.tsx`, `LinkArcs.tsx`) will need a glossary or invariant once it lands.

Budget 45–90 minutes. The drafted `system.md` is intentionally a first cut — its authority comes from your review, not from the bootstrap.
