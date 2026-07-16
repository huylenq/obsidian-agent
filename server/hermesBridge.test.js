import assert from "node:assert/strict";
import test from "node:test";

process.env.HERMES_AGENT_LOG_FILE = "/tmp/hermes-agent-bridge-test.log";
const { handleBridgeRequest } = await import("./hermesBridge.js");

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.messages = [];
    this.closed = null;
  }

  send(raw) {
    this.messages.push(JSON.parse(raw));
  }

  close(code, reason) {
    this.closed = { code, reason };
  }
}

function request(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

test("authenticates a bridge connection and answers ping", async () => {
  process.env.AUTH_TOKEN = "secret";
  const socket = new FakeSocket();
  const state = { authenticated: false, chats: new Map() };

  await handleBridgeRequest(
    socket,
    state,
    request(1, "bridge/authenticate", { authToken: "secret" }),
    "/vault",
  );
  await handleBridgeRequest(socket, state, request(2, "bridge/ping"), "/vault");

  assert.equal(state.authenticated, true);
  assert.deepEqual(socket.messages[0].result, { authenticated: true });
  assert.deepEqual(socket.messages[1].result, { ok: true });
});

test("rejects an invalid bridge token", async () => {
  process.env.AUTH_TOKEN = "secret";
  const socket = new FakeSocket();
  const state = { authenticated: false, chats: new Map() };

  await handleBridgeRequest(
    socket,
    state,
    request(1, "bridge/authenticate", { authToken: "wrong" }),
    "/vault",
  );

  assert.equal(socket.messages[0].error.code, 401);
  assert.deepEqual(socket.closed, { code: 1008, reason: "Unauthorized" });
});

test("requires authentication before chat methods", async () => {
  process.env.AUTH_TOKEN = "secret";
  const socket = new FakeSocket();
  const state = { authenticated: false, chats: new Map() };

  await handleBridgeRequest(socket, state, request(1, "chat/start"), "/vault");

  assert.equal(socket.messages[0].error.code, 401);
  assert.equal(state.chats.size, 0);
});

test("returns the effective ACP provider and model choices for a session", async () => {
  delete process.env.AUTH_TOKEN;
  const socket = new FakeSocket();
  const state = { authenticated: true, chats: new Map() };
  const acpClient = {
    async openSession({ sessionId, cwd }) {
      assert.equal(sessionId, "session-models");
      assert.equal(cwd, "/vault");
      return {
        sessionId,
        models: {
          currentModelId: "openai-codex:gpt-5.6-sol",
          availableModels: [
            { modelId: "openai-codex:gpt-5.6-sol", name: "gpt-5.6-sol" },
          ],
        },
      };
    },
  };

  await handleBridgeRequest(
    socket,
    state,
    request(1, "session/models", { sessionId: "session-models" }),
    "/vault",
    acpClient,
  );

  assert.equal(socket.messages[0].result.sessionId, "session-models");
  assert.equal(
    socket.messages[0].result.models.currentModelId,
    "openai-codex:gpt-5.6-sol",
  );
});

test("switches the effective ACP model and returns refreshed model state", async () => {
  delete process.env.AUTH_TOKEN;
  const socket = new FakeSocket();
  const state = { authenticated: true, chats: new Map() };
  const calls = [];
  const acpClient = {
    async openSession({ sessionId }) {
      calls.push(["open", sessionId]);
      return {
        sessionId,
        models: {
          currentModelId: "anthropic:claude-sonnet-4-6",
          availableModels: [
            { modelId: "anthropic:claude-sonnet-4-6", name: "claude-sonnet-4-6" },
          ],
        },
      };
    },
    async setModel(sessionId, modelId) {
      calls.push(["set", sessionId, modelId]);
      return {
        sessionId,
        models: {
          currentModelId: modelId,
          availableModels: [
            { modelId, name: "claude-sonnet-4-6" },
          ],
        },
      };
    },
  };

  await handleBridgeRequest(
    socket,
    state,
    request(1, "session/set-model", {
      sessionId: "session-models",
      modelId: "anthropic:claude-sonnet-4-6",
    }),
    "/vault",
    acpClient,
  );

  assert.deepEqual(calls, [
    ["open", "session-models"],
    ["set", "session-models", "anthropic:claude-sonnet-4-6"],
  ]);
  assert.equal(
    socket.messages[0].result.models.currentModelId,
    "anthropic:claude-sonnet-4-6",
  );
});
