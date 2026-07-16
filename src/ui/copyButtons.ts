/**
 * Shared copy-button utility for rendered content blocks
 * (DOT diagrams, LaTeX/MathJax, future copiable snippets).
 *
 * Uses the same icon + style as Obsidian's copy-code-button.
 */

import { setIcon } from "obsidian";

/** Create a copy button matching Obsidian's copy-code-button style (icon only). */
export function createCopyButton(getText: () => string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "copy-code-button hermes-agent-copy-btn";
  setIcon(btn, "copy");
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(getText());
    if (resetTimer) clearTimeout(resetTimer);
    setIcon(btn, "check");
    btn.style.color = "var(--color-green)";
    resetTimer = setTimeout(() => {
      setIcon(btn, "copy");
      btn.style.color = "";
      resetTimer = null;
    }, 1500);
  });
  return btn;
}

/** Create a button group container (floating top-right, visible on parent hover). */
export function createCopyButtonGroup(...buttons: HTMLButtonElement[]): HTMLDivElement {
  const group = document.createElement("div");
  group.className = "hermes-agent-copy-buttons";
  group.append(...buttons);
  return group;
}

/** Extract display-math LaTeX sources ($$...$$) from raw markdown, in order. */
function extractDisplayMathSources(markdown: string): string[] {
  const sources: string[] = [];
  const re = /\$\$([\s\S]*?)\$\$/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    sources.push(match[1].trim());
  }
  return sources;
}

/**
 * Find MathJax `mjx-container` display elements and attach a copy button.
 * Since MathJax CHTML doesn't preserve the source, we extract it from the raw markdown.
 * Display-math blocks in the markdown correspond 1:1 with rendered mjx-container[display] elements.
 */
export function attachLatexCopyButtons(container: HTMLElement, rawMarkdown: string): void {
  const mathEls = Array.from(
    container.querySelectorAll<HTMLElement>('mjx-container[display="true"]')
  );
  if (mathEls.length === 0) return;

  const sources = extractDisplayMathSources(rawMarkdown);
  if (sources.length !== mathEls.length) return; // Bail on mismatch — avoid wrong labels

  for (let i = 0; i < mathEls.length; i++) {
    const mjx = mathEls[i];
    const latex = sources[i];

    // The parent is <span class="math math-block is-loaded"> — wrap that
    const mathSpan = mjx.parentElement;
    if (!mathSpan?.parentElement) continue;

    // Already wrapped
    if (mathSpan.parentElement.classList.contains("hermes-agent-math-block")) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "hermes-agent-math-block";
    mathSpan.parentElement.insertBefore(wrapper, mathSpan);
    wrapper.appendChild(mathSpan);

    wrapper.appendChild(createCopyButtonGroup(createCopyButton(() => latex)));
  }
}
