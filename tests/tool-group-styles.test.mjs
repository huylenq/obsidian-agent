import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const messages = readFileSync(new URL("../src/styles/messages.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/styles/layout.css", import.meta.url), "utf8");
const prefix = messages.includes(".hermes-agent-tool-group-icon-disc") ? "hermes" : "claude";
const cls = (suffix) => `.${prefix}-agent-${suffix}`;

const ruleBody = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
};

const container = ruleBody(layout, cls("container"));
assert.match(container, /--hermes-agent-chat-background:\s*var\(--background-primary\)/);
assert.match(container, /background:\s*var\(--hermes-agent-chat-background\)/);

const disc = ruleBody(messages, cls("tool-group-icon-disc"));
assert.match(disc, /background:\s*var\(--hermes-agent-chat-background\)/);

const latestDisc = ruleBody(
  messages,
  `${cls("tool-group-icon")}.latest ${cls("tool-group-icon-disc")}`,
);
assert.doesNotMatch(latestDisc, /interactive-accent|animation/);
assert.match(latestDisc, /background:\s*var\(--hermes-agent-chat-background\)/);

const hoverDisc = ruleBody(
  messages,
  `${cls("tool-group-header")}:hover ${cls("tool-group-icon")} ${cls("tool-group-icon-disc")}`,
);
assert.match(hoverDisc, /background:\s*transparent/);

const latestIcon = ruleBody(messages, `${cls("tool-group-icon")}.latest`);
assert.match(latestIcon, /color:\s*var\(--interactive-accent\)/);

const latestGlyph = ruleBody(
  messages,
  `${cls("tool-group-icon")}.latest ${cls("tool-group-icon-glyph")}`,
);
assert.match(latestGlyph, new RegExp(`animation:\\s*${prefix}-agent-pulse 1\\.2s infinite`));

const errorIcon = ruleBody(
  messages,
  `${cls("tool-group")}.error ${cls("tool-group-icon")}.latest`,
);
assert.match(errorIcon, /color:\s*var\(--text-error\)/);

console.log("tool-group style invariants: ok");
