# ADR-0002: Self-owned LanceDB vector index

Date: 2026-05-12
Status: accepted

## Context

The plugin needs a vault-wide vector index to power Relevant Notes ranking, the semantic graph's similarity edges, and any future semantic-search MCP tools. There are roughly three ways to get one:

1. Piggyback on a peer plugin that already maintains an index (in practice: obsidian-copilot).
2. Build our own.
3. Send queries to a hosted embedding+vector-DB service and skip local storage.

The plugin originally took path (1) — a parasitic dependency on Copilot's index. That coupling broke independently of the plugin: it depended on Copilot being installed, configured, and using a compatible embedding model; reindex semantics were not under our control; users without Copilot had no semantic features at all.

## Decision

Run a self-owned vector index. LanceDB, embedded inside the Hermes bridge, with files stored at `<vault>/.obsidian/lance/`. Notes are chunked heading-aware (~6000 chars per chunk) by `server/embeddings/chunker.js`, embedded via OpenAI `text-embedding-3-small` (1536 dims), and incrementally updated on server startup by file mtime. The index is exposed to plugin code through the `IIndexClient` interface (`src/embeddings/IIndexClient.ts`); currently one implementation, `AgentIndexClient`, talks HTTP to the bridge's `/index/*` endpoints.

## Consequences

**Enables:**
- No external plugin dependency. The plugin works in vaults that don't have Copilot installed.
- Full control over chunking, embedding model, and indexing cadence. Heading-aware chunking is specific to this plugin's needs and wouldn't survive a Copilot upgrade that changed strategies.
- A clean seam (`IIndexClient`) for swapping the backend later — e.g. an in-process index, a hosted service, or a different vector store.

**Forecloses / costs:**
- A working setup now requires an OpenAI API key in plugin settings. This is the most visible source of friction for new users and a publishability blocker on its own; tracked under "Things deliberately not specified → Community-store publication" in `system.md`.
- The bridge is now responsible for vault scanning, chunking, and index health. Mistakes here can corrupt the index file, which is expensive to rebuild on a large vault.
- An extra binary dependency in the server bundle (LanceDB native artifacts), with the usual cross-platform packaging implications.

## Alternatives considered

- **Continue using Copilot's index.** Rejected — the dependency was unreliable in practice and worsened the publication story rather than helping it.
- **SQLite + sqlite-vec** (the OpenClaw approach documented in `OPENCLAW_REPLICATION_PLAN.md`). Plausible alternative with comparable feature surface; LanceDB was chosen for the cleaner Node API and avoiding a native-extension build step for sqlite-vec. Could be revisited if LanceDB's footprint becomes a problem.
- **Hosted embedding + vector service.** Faster to ship, but moves vault content off-device on every reindex and creates a hard runtime dependency on a third-party service that isn't already in scope. Rejected.
