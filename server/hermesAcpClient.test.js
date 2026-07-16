import assert from "node:assert/strict";
import test from "node:test";

process.env.HERMES_AGENT_LOG_FILE = "/tmp/hermes-agent-acp-client-test.log";
const { HermesAcpClient, resolveHermesCommand } = await import("./hermesAcpClient.js");

test("uses HERMES_BIN when explicitly configured", () => {
  const command = resolveHermesCommand({
    env: { HERMES_BIN: "/custom/hermes" },
    home: "/Users/test",
    isExecutable: () => false,
  });

  assert.equal(command, "/custom/hermes");
});

test("finds the standard user-local Hermes install outside GUI PATH", () => {
  const executable = "/Users/test/.local/bin/hermes";
  const command = resolveHermesCommand({
    env: {},
    home: "/Users/test",
    isExecutable: (candidate) => candidate === executable,
  });

  assert.equal(command, executable);
});

test("finds the Hermes managed-venv executable as a fallback", () => {
  const executable = "/Users/test/.hermes/hermes-agent/venv/bin/hermes";
  const command = resolveHermesCommand({
    env: {},
    home: "/Users/test",
    isExecutable: (candidate) => candidate === executable,
  });

  assert.equal(command, executable);
});

test("falls back to PATH lookup when no standard install exists", () => {
  const command = resolveHermesCommand({
    env: {},
    home: "/Users/test",
    isExecutable: () => false,
  });

  assert.equal(command, "hermes");
});

test("preserves ACP model state when opening a new session", async () => {
  const client = new HermesAcpClient();
  client.ensureStarted = async () => {};
  client.call = async (method) => {
    assert.equal(method, "session/new");
    return {
      sessionId: "session-models",
      models: {
        currentModelId: "openai-codex:gpt-5.6-sol",
        availableModels: [
          { modelId: "openai-codex:gpt-5.6-sol", name: "gpt-5.6-sol" },
        ],
      },
    };
  };

  const opened = await client.openSession({ cwd: "/vault" });

  assert.equal(opened.sessionId, "session-models");
  assert.equal(opened.models.currentModelId, "openai-codex:gpt-5.6-sol");
  assert.equal(opened.resumed, false);
});

test("preserves ACP model state when loading a session", async () => {
  const client = new HermesAcpClient();
  client.ensureStarted = async () => {};
  client.call = async (method) => {
    assert.equal(method, "session/load");
    return {
      models: {
        currentModelId: "anthropic:claude-sonnet-4-6",
        availableModels: [
          { modelId: "anthropic:claude-sonnet-4-6", name: "claude-sonnet-4-6" },
        ],
      },
    };
  };

  const opened = await client.openSession({ sessionId: "existing", cwd: "/vault" });

  assert.equal(opened.sessionId, "existing");
  assert.equal(opened.models.currentModelId, "anthropic:claude-sonnet-4-6");
  assert.equal(opened.resumed, true);
});

test("switches a session model through the ACP protocol", async () => {
  const client = new HermesAcpClient();
  const calls = [];
  client.call = async (method, params) => {
    calls.push([method, params]);
    if (method === "session/load") {
      return {
        models: {
          currentModelId: "anthropic:claude-sonnet-4-6",
          availableModels: [],
        },
      };
    }
    return {};
  };

  const updated = await client.setModel(
    "session-models",
    "anthropic:claude-sonnet-4-6",
  );

  assert.deepEqual(calls[0], ["session/set_model", {
    sessionId: "session-models",
    modelId: "anthropic:claude-sonnet-4-6",
  }]);
  assert.equal(calls[1][0], "session/load");
  assert.equal(updated.models.currentModelId, "anthropic:claude-sonnet-4-6");
});
