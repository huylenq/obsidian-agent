# ADR-0001: Sidecar bridge architecture

Date: 2026-05-12
Status: accepted; revised 2026-07-15

## Context

Hermes exposes Agent Client Protocol (ACP) through a long-lived CLI process. An
Obsidian renderer cannot reliably spawn and supervise that process, and Obsidian
mobile cannot spawn it at all. Both desktop and mobile therefore need a small
network boundary between the plugin UI and Hermes ACP.

Chat is bidirectional and long-lived: the client starts a turn, receives streamed
updates, and may steer or cancel while the turn is active. Modeling that lifecycle
as several request and streaming mechanisms adds state and reconnect edge cases.

## Decision

Ship `server/` as the Hermes bridge. It owns one `hermes acp` subprocess and
speaks newline-delimited ACP JSON-RPC over stdio.

The plugin maintains one authenticated WebSocket at `/bridge`. JSON-RPC-style
messages carry `chat/start`, `chat/inject`, and `chat/interrupt`; the bridge sends
streamed `chat/event` notifications on the same connection. Authentication is the
first bridge request because browser WebSocket clients cannot set an Authorization
header during the upgrade.

HTTP is retained only for finite support operations: health, indexing, history,
and session metadata. It is not part of the chat transport.

`server/hermesBridge.js` owns WebSocket dispatch, `server/chatSession.js` owns one
chat lifecycle, and `server/hermesAcpClient.js` owns ACP process communication.
Hermes' session database is the source of truth for model context. The bridge also
writes display transcripts and sidecars under
`~/.hermes/obsidian-agent/projects/`.

Desktop local mode starts the bridge as a child process on `localhost:27182`.
Mobile points the same client at a network-visible bridge, normally through a
private tunnel such as Tailscale.

## Consequences

**Enables:**

- One chat transport and one per-connection lifecycle registry.
- Streaming, steering, cancellation, and session resume without renderer-side ACP
  process management.
- A thin mobile client using the same WebSocket contract as desktop.
- Hermes-managed tools, MCP servers, compaction, rules, skills, and memory.

**Costs:**

- Mobile still depends on a bridge host and secure network path.
- The bridge and Hermes CLI must be installed, updated, and supervised outside
  Obsidian mobile.
- The plugin remains unsuitable for the Obsidian community store because desktop
  local mode depends on a sidecar process.
- Remote deployments must protect the bridge token and use an encrypted tunnel or
  TLS endpoint.

## Alternatives considered

- **ACP directly in the renderer.** Rejected because ACP is exposed by a process
  that mobile cannot launch and renderer process support is unreliable.
- **A separate streaming HTTP chat API.** Rejected because WebSocket already
  covers start, events, steering, cancellation, and reconnect ownership with one
  protocol.
- **A native mobile Hermes runtime.** Not currently available; it would also split
  session and tool configuration between desktop and mobile environments.
