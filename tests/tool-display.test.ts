import assert from "node:assert/strict";
import test from "node:test";

import { inspectGroup } from "../src/ui/toolDisplay";

test("an active retry keeps the group running even when an earlier tool failed", () => {
  const failed = {
    toolUseId: "write-failed",
    toolName: "Write",
    description: "Write note",
    isError: true,
    isRunning: false,
  };
  const retry = {
    toolUseId: "write-retry",
    toolName: "Write",
    description: "Retry write note",
    isRunning: true,
  };

  const inspection = inspectGroup([failed, retry]);

  assert.equal(inspection.status, "running");
  assert.equal(inspection.runningBlock?.toolUseId, "write-retry");
  assert.equal(inspection.errorBlock?.toolUseId, "write-failed");
});
