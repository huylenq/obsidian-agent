import type { Viz } from "@viz-js/viz";

let vizInstance: Viz | null = null;

async function getViz(): Promise<Viz> {
  if (vizInstance) return vizInstance;
  const { instance } = await import("@viz-js/viz");
  vizInstance = await instance();
  return vizInstance;
}

function bracesBalanced(src: string): boolean {
  let depth = 0;
  for (const ch of src) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

export async function renderDotBlocks(container: HTMLElement): Promise<void> {
  const viz = await getViz();
  const codeBlocks = Array.from(
    container.querySelectorAll<HTMLElement>("pre > code.language-dot")
  );

  for (const code of codeBlocks) {
    const pre = code.parentElement;
    if (!pre) continue;

    const dotSource = code.textContent || "";

    // Skip incomplete blocks during streaming
    if (!bracesBalanced(dotSource)) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "claude-agent-dot-diagram";

    try {
      const svg = viz.renderSVGElement(dotSource);
      // No JS color manipulation — dark mode handled via CSS filter
      wrapper.appendChild(svg);

      // Copy DOT button
      const copyBtn = document.createElement("button");
      copyBtn.className = "claude-agent-dot-copy";
      copyBtn.textContent = "Copy DOT";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(dotSource);
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy DOT"), 1500);
      });
      wrapper.appendChild(copyBtn);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      wrapper.classList.add("dot-error");
      wrapper.innerHTML = `<div class="claude-agent-dot-error-msg">${msg}</div><pre><code>${dotSource}</code></pre>`;
    }

    pre.replaceWith(wrapper);
  }
}
