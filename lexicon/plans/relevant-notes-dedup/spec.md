# Plan: Relevant-Notes dedup

Started: 2026-05-12
Status: draft

## Goal

Fold the two parallel implementations of the Relevant-Notes UI — the standalone `RelevantNotesView` and the chat-embedded `RelevantNotes` panel — so that the toolbar, mode toggle, empty/error states, and overall rendering pipeline live in one component. Today both paths render `RelevantNoteCard` rows from the same data, but each owns its own toolbar markup, its own mode-toggle wiring, and its own empty/error branches. Drift between them is a question of "when", not "if".

## Anchors in system.md

- Glossary terms: **Relevant Notes** (Glossary), **Surface** + **Region** vocabulary in the new Design system section.
- Bounded contexts: **Embeddings & Retrieval** (owns the UI for relevant notes; same context for both paths).
- Invariants depended on: ranking math (70% similarity + 30% link weight) is a single source — `rankNotes` in `src/embeddings/search.ts`. Both paths already share it; no invariant change needed.
- Invariants potentially affected: none expected — this is a UI fold, not a behavior change.

## Approach

Lift the rendering body of the panel into a single `RelevantNotesPanel` component (or rename the existing `src/ui/RelevantNotes/RelevantNotes.tsx`) and have both surfaces use it. Differences between standalone and embedded are limited to:

- The standalone version has no `ResizeHandle`; the embedded version does.
- The standalone version is mounted as the body of an `ItemView`; the embedded version is mounted inside `ChatView`'s right-hand region.
- The embedded version is collapsible via a header chevron; the standalone version always shows the list.

Express these as props (`showResizeHandle?: boolean`, `collapsible?: boolean`) rather than as forks of the rendering tree. `RelevantNotesView` becomes a thin shell that hosts the panel; the chat-embedded usage stays where it is but stops duplicating toolbar / empty / error logic.

Consider:

- Whether the mode toggle (This File / Chat Context) should be lifted to a shared `Toolbar` primitive (the same toggle shape lives in `SessionsView` too). If yes, that's a separate small refactor — flag it but don't bundle.
- Whether the embedded path should be allowed to *drop* the toolbar entirely (saving vertical space inside the chat surface) by passing `showToolbar={false}`. This is a UX call, not a refactor mandate.

## Sessions expected

- [ ] Session 1: read both files end-to-end, list every divergence as a checklist; decide which become props and which become deletions.
- [ ] Session 2: lift the shared body, switch both call sites, verify both surfaces render correctly.

## Out of scope

- Changing `rankNotes` behavior or the ranking weights.
- Touching `RelevantNoteCard` itself — the row component is already shared.
- Extracting a shared `Toolbar` primitive across Sessions and Relevant Notes (separate concern; flag if encountered).
- Mobile-specific UX changes.

## Open questions

- Does the embedded variant need to keep the mode toggle, or is the chat-embedded context implicitly "This File"?
- Is the `ResizeHandle` worth keeping at all, or has it been superseded by the surrounding workspace's resize affordances?

## Decisions made

*(none yet)*
