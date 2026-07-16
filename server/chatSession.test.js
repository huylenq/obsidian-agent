import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRegistry } from "./sessions.js";
import { getTranscriptPath } from "./transcript.js";

process.env.HERMES_AGENT_LOG_FILE = "/tmp/hermes-agent-bridge-test.log";
const { ChatSession } = await import("./chatSession.js");

test("streams an ACP chat and persists it before the done event", async () => {
  const home = mkdtempSync(join(tmpdir(), "hermes-bridge-test-"));
  const previousHome = process.env.HERMES_OBSIDIAN_AGENT_HOME;
  process.env.HERMES_OBSIDIAN_AGENT_HOME = home;

  const vaultPath = "/test/vault";
  const events = [];
  const prompts = [];
  const fakeAcpClient = {
    async openSession({ sessionId, cwd }) {
      assert.equal(sessionId, undefined);
      assert.equal(cwd, vaultPath);
      return {
        sessionId: "session-test",
        models: {
          currentModelId: "openai-codex:gpt-5.6-sol",
          availableModels: [],
        },
      };
    },
    async prompt(sessionId, prompt, onUpdate) {
      prompts.push({ sessionId, prompt });
      onUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello from Hermes" },
      });
      return { stopReason: "end_turn", usage: { outputTokens: 3 } };
    },
    async steer() {},
    cancel() {},
  };

  try {
    const chat = new ChatSession({
      id: "chat-test",
      request: { message: "Hello", activeFile: { path: "Notes/Test.md" } },
      vaultPath,
      onEvent(event) {
        if (event.type === "done") {
          assert.equal(loadRegistry(vaultPath).sessions.length, 1);
        }
        events.push(event);
      },
      acpClient: fakeAcpClient,
    });

    await chat.run();

    assert.deepEqual(events.map((event) => event.type), [
      "session",
      "text",
      "result",
      "done",
    ]);
    assert.equal(events.at(-1).sessionId, "session-test");
    assert.equal(prompts[0].sessionId, "session-test");
    assert.match(prompts[0].prompt[0].text, /Hello/);

    const transcript = readFileSync(getTranscriptPath(vaultPath, "session-test"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(transcript.map((entry) => entry.type), ["user", "assistant"]);
    assert.equal(transcript[1].message.content[0].text, "Hello from Hermes");

    const registryEntry = loadRegistry(vaultPath).sessions[0];
    assert.equal(registryEntry.id, "session-test");
    assert.equal(registryEntry.model, "openai-codex:gpt-5.6-sol");
    assert.equal(registryEntry.messageCount, 2);
    assert.deepEqual(registryEntry.files, ["Notes/Test.md"]);
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_OBSIDIAN_AGENT_HOME;
    else process.env.HERMES_OBSIDIAN_AGENT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("steer acknowledgement is not merged into the active assistant response", async () => {
  const home = mkdtempSync(join(tmpdir(), "hermes-bridge-steer-test-"));
  const previousHome = process.env.HERMES_OBSIDIAN_AGENT_HOME;
  process.env.HERMES_OBSIDIAN_AGENT_HOME = home;

  const vaultPath = "/test/vault";
  const events = [];
  let promptUpdate;
  let releasePrompt;
  let markPromptStarted;
  const promptStarted = new Promise((resolve) => {
    markPromptStarted = resolve;
  });

  const fakeAcpClient = {
    async openSession() {
      return { sessionId: "session-steer" };
    },
    async prompt(_sessionId, _prompt, onUpdate) {
      promptUpdate = onUpdate;
      markPromptStarted();
      await new Promise((resolve) => {
        releasePrompt = resolve;
      });
      return { stopReason: "end_turn" };
    },
    async steer() {
      promptUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "⏩ Steer queued for the active turn: nè" },
      });
      return { stopReason: "end_turn" };
    },
    cancel() {},
  };

  try {
    const chat = new ChatSession({
      id: "chat-steer",
      request: { message: "Test thử Lulu trong Obsidian nè" },
      vaultPath,
      onEvent(event) {
        events.push(event);
      },
      acpClient: fakeAcpClient,
    });

    const runPromise = chat.run();
    await promptStarted;
    await chat.inject({ message: "nè" });
    promptUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Dạ, final response riêng nè anh." },
    });
    releasePrompt();
    await runPromise;

    assert.deepEqual(
      events.filter((event) => event.type === "text").map((event) => event.content),
      ["Dạ, final response riêng nè anh."],
    );

    const transcript = readFileSync(getTranscriptPath(vaultPath, "session-steer"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const assistant = transcript.find((entry) => entry.type === "assistant");
    assert.equal(assistant.message.content[0].text, "Dạ, final response riêng nè anh.");
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_OBSIDIAN_AGENT_HOME;
    else process.env.HERMES_OBSIDIAN_AGENT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
