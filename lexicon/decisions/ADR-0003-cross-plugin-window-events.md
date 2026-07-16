# ADR-0003: Cross-plugin integration via window events

Date: 2026-05-12
Status: accepted; amended 2026-07-15

## Context

The agent plugin and the `inline-flashcards` plugin need to talk. The integration is bidirectional:

- Anki deeplinks routed by `inline-flashcards` need to hand off "explain this flashcard" requests to the agent (with question, answer, context, card ID, source file).
- Flashcard bubbles rendered by the agent need to scroll the user back to the source card in `inline-flashcards`.

Both plugins live in the same Obsidian renderer. Several integration shapes are technically possible: a shared module imported by both, a globally registered API object on `window`, direct calls into the other plugin's instance via `app.plugins.getPlugin(...)`, or fire-and-forget DOM events.

Each plugin can be enabled or disabled independently. The user may have both, one, or neither. They are not co-released.

## Decision

Use `window.dispatchEvent` + `addEventListener` for cross-plugin communication. Events are namespaced by source: outgoing events from the agent use the `hermes-agent:` prefix (`hermes-agent:explain-flashcard`, `hermes-agent:send-message`); incoming events the agent listens for use the `flashcard:` prefix (`flashcard:navigate`). Payloads are passed via `CustomEvent.detail` as plain serializable objects.

The Hermes rename changes the active namespace from the former plugin prefix. During migration, the plugin also listens for the former `explain-flashcard` event so an older `inline-flashcards` installation can still hand off requests.

## Consequences

**Enables:**
- Loose coupling. Either plugin works on its own. If the counterparty isn't loaded, the event simply has no listener — no error, no broken feature on the side that *is* present.
- Independent release cadence. Neither plugin imports the other; bumping versions is unilateral.
- Easy debugging — events show up in DevTools and can be hand-fired from the console for testing.

**Forecloses / costs:**
- No type safety across the boundary. Payload shapes are documented in `agent/AGENTS.md` and the inline-flashcards code; drift between the two is caught only by manual testing or by failures at runtime.
- No request/response handshake. The agent dispatches `hermes-agent:send-message` and assumes someone is listening; there's no synchronous "did the other side receive it?". Acceptable for the current handoffs (they're fire-and-forget), would need rework for anything transactional.
- The event-name namespace is a shared resource. New event names need to be coordinated between the two plugin codebases by convention, not enforcement.

## Alternatives considered

- **Direct plugin-instance access via `app.plugins.getPlugin("inline-flashcards")`.** Tighter coupling. Works, but breaks if the other plugin is disabled, missing, or its instance shape changes. Rejected for fragility.
- **A shared "obsidian-pkm-bridge" library both plugins import.** Cleanest in theory; in practice it means a third package, a release coordination story, and a versioning headache for what is currently four event names. Over-engineered for the current scope.
- **A globally registered API object** (e.g. `window.hermesAgentAPI = { ... }`). Slightly stronger contract than events, but requires both sides to know about load order and re-registration on enable/disable. Events sidestep that.
