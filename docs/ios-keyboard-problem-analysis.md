# iOS Mobile Keyboard — Problem Analysis

## Problem

When the chat view's textarea is focused on iOS mobile, a large black area slides up from the bottom, concealing most of the chat content. The input area is not properly positioned above the keyboard.

## Root Cause

Obsidian runs in a **WKWebView** on iOS. When the virtual keyboard opens, iOS does NOT resize the layout viewport — it keeps the full-screen dimensions. Instead, iOS **scrolls the webview** to reveal the focused element. This creates a disconnect:

- The `.claude-agent-container` has `height: 100%` (of its parent `.view-content`)
- The parent doesn't shrink when the keyboard opens
- iOS scrolls an ancestor element upward to show the textarea
- The messages area (`flex: 1`) retains its full height — most of it is now empty/black
- The user sees: a sliver of content at top → black void → textarea → keyboard

## What We Tried

### 1. CSS `height: 100dvh` (global)

```css
.claude-agent-container {
  height: 100%;
  height: 100dvh;  /* override with dynamic viewport height */
}
```

**Result:** Broke desktop. `100dvh` is relative to the browser viewport, not the Obsidian panel. On desktop, the chat view lives in a sidebar/tab that's smaller than the viewport, so the container overflows its parent, pushing the input area below the visible area.

### 2. CSS `height: 100dvh` (mobile-only)

```css
.is-mobile .claude-agent-container {
  height: 100dvh;
}
```

**Result:** Best so far, but imperfect. The container resizes when the keyboard opens (confirmed — `dvh` does respond to keyboard on iOS). However, the **input area doesn't slide up with the keyboard** — it stays at the bottom of the resized container but isn't visually tracked to the keyboard animation. The experience feels broken because the input disappears momentarily during the keyboard slide-up.

### 3. `visualViewport` resize event → set container height

```js
window.visualViewport.addEventListener("resize", () => {
  container.style.height = `${visualViewport.height}px`;
});
```

**Result:** No effect. The `resize` event does not appear to fire in Obsidian's WKWebView when the keyboard opens.

### 4. `visualViewport` polling (100ms interval)

```js
setInterval(() => {
  container.style.height = `${visualViewport.height}px`;
}, 100);
```

**Result:** No effect. `visualViewport.height` does not change when the keyboard opens in Obsidian's WKWebView, suggesting the WKWebView configuration doesn't expose viewport changes to JS.

### 5. Ancestor scroll reset

```js
// On visualViewport resize/scroll:
window.scrollTo(0, 0);
document.documentElement.scrollTop = 0;
// Walk up DOM resetting scrollTop on all ancestors
```

**Result:** No effect. The scroll created by iOS happens at the native WKWebView level, outside of CSS scroll — our JS resets don't reach it.

### 6. Ancestor `overflow: hidden` lock

```js
// Walk up from container, set overflow: hidden on all ancestors
```

**Result:** Broke messages scrolling entirely. Too aggressive — it also locked the `.claude-agent-messages` container's scroll context.

## Key Findings

| Signal | Value |
|--------|-------|
| `100dvh` responds to keyboard | **Yes** — the CSS unit does shrink |
| `visualViewport` events fire | **No** — neither `resize` nor `scroll` |
| `visualViewport.height` changes | **No** — stays constant (polled at 100ms) |
| `window.innerHeight` changes | **Unknown** — not directly tested |
| `window resize` event fires | **Unknown** — not directly tested |
| iOS native scroll reachable via JS | **No** — `scrollTo`/`scrollTop` resets have no effect |
| Parent `.view-content` resizes | **Unknown** — we didn't get to deploy the debug banner |

## The Core Dilemma

The fundamental issue is that we need the container to:
1. **On desktop:** fill its parent (which is smaller than viewport) → needs `height: 100%`
2. **On mobile without keyboard:** fill the screen → `100%` or `100dvh` both work
3. **On mobile with keyboard:** shrink to visible area above keyboard → needs `100dvh`

`100dvh` solves #3 but breaks #1. `100%` solves #1 but fails at #3.

The mobile-only `100dvh` override is the closest, but the input doesn't animate with the keyboard — it jumps position after the keyboard finishes opening, which Huy considers broken.

## Unexplored Approaches

### A. `env(keyboard-inset-height)` + VirtualKeyboard API
Requires `navigator.virtualKeyboard.overlaysContent = true`. Unlikely to work in WKWebView but not tested.

### B. ResizeObserver on `.view-content` parent
If Obsidian resizes the parent when the keyboard opens, a ResizeObserver could detect it and set the container height. This would work like `height: 100%` but with explicit pixel values that update dynamically.

### C. Native Obsidian approach
Study how Obsidian's own editor view handles the keyboard on mobile. It works correctly — the editor resizes and the toolbar stays above the keyboard. There may be native-level keyboard avoidance that only applies to Obsidian's built-in views, or there may be CSS patterns we can replicate.

### D. `position: fixed` + `bottom: 0` for input area only
Instead of resizing the whole container, keep the container at `100%` and make just the input area `position: fixed; bottom: 0` on mobile. iOS might position fixed elements above the keyboard in newer versions. Risk: fixed positioning in WKWebView has historically been unreliable.

### E. Debug banner deployment
Deploy the diagnostic banner we built (shows `innerHeight`, `visualViewport.height`, parent dimensions, etc.) to get actual runtime values before and after keyboard opens. This eliminates guesswork about which APIs work in Obsidian's WKWebView.

### F. Study Obsidian's `.workspace-leaf-content` behavior
Inspect whether Obsidian adds/removes CSS classes or inline styles on the leaf content when the keyboard opens. If it does, we can hook into those changes.
