import assert from "node:assert/strict";
import test from "node:test";

import { getChatInputKeyAction } from "../src/ui/inputKeyHandling.ts";

test("Enter only commits an active IME composition and does not submit", () => {
  assert.equal(
    getChatInputKeyAction({
      key: "Enter",
      shiftKey: false,
      isMobile: false,
      isComposing: true,
      keyCode: 13,
    }),
    "ignore",
  );
});

test("keyCode 229 is treated as IME composition even when the browser flag is false", () => {
  assert.equal(
    getChatInputKeyAction({
      key: "Enter",
      shiftKey: false,
      isMobile: false,
      isComposing: false,
      keyCode: 229,
    }),
    "ignore",
  );
});

test("plain desktop Enter submits while Shift+Enter continues editing", () => {
  assert.equal(
    getChatInputKeyAction({
      key: "Enter",
      shiftKey: false,
      isMobile: false,
      isComposing: false,
      keyCode: 13,
    }),
    "submit",
  );
  assert.equal(
    getChatInputKeyAction({
      key: "Enter",
      shiftKey: true,
      isMobile: false,
      isComposing: false,
      keyCode: 13,
    }),
    "continue",
  );
});
