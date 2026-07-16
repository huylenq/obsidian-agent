import { spawn } from "child_process";
import { accessSync, constants } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { log, logError } from "./log.js";

const CALL_TIMEOUT_MS = 120_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function canExecute(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve installs that macOS GUI applications commonly cannot see on PATH. */
export function resolveHermesCommand({
  env = process.env,
  home = homedir(),
  isExecutable = canExecute,
} = {}) {
  if (env.HERMES_BIN) return env.HERMES_BIN;

  const candidates = [
    join(home, ".local", "bin", "hermes"),
    join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
  ];
  return candidates.find(isExecutable) || "hermes";
}

function selectPermissionOption(options = []) {
  const ranks = new Map([
    ["allow_always", 3],
    ["allow_session", 2],
    ["allow_once", 1],
  ]);
  let selected = null;
  let selectedRank = 0;
  for (const option of options) {
    const rank = ranks.get(option.optionId) ?? ranks.get(option.kind) ?? 0;
    if (rank > selectedRank) {
      selected = option.optionId;
      selectedRank = rank;
    }
  }
  return selected;
}

/**
 * Long-lived JSON-RPC 2.0 client for `hermes acp`.
 *
 * One subprocess serves every Obsidian session. Responses are correlated by
 * request id, while `session/update` notifications are routed by session id.
 */
export class HermesAcpClient {
  constructor({ command = resolveHermesCommand() } = {}) {
    this.command = command;
    this.process = null;
    this.nextId = 0;
    this.pending = new Map();
    this.sessionHandlers = new Map();
    this.openSessions = new Set();
    this.sessionMetadata = new Map();
    this.startPromise = null;
    this.capabilities = null;
  }

  async ensureStarted() {
    if (this.process) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async start() {
    log(`[Hermes ACP] Starting ${this.command} acp`);
    const child = spawn(this.command, ["acp", "--accept-hooks"], {
      cwd: process.env.HOME,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) log(`[Hermes ACP] ${text}`);
    });
    child.on("error", (error) => this.handleExit(error));
    child.on("exit", (code, signal) => {
      this.handleExit(new Error(`Hermes ACP exited (code=${code}, signal=${signal})`));
    });

    try {
      const initialized = await this.call("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
        clientInfo: {
          name: "obsidian-hermes-agent",
          title: "Obsidian Hermes Agent",
          version: "0.1.0",
        },
      }, 30_000, { skipEnsureStarted: true });
      if (!initialized?.protocolVersion) {
        throw new Error("Hermes ACP did not advertise a protocol version");
      }
      this.capabilities = initialized;
      log(
        `[Hermes ACP] Connected to ${initialized.agentInfo?.name || "agent"} ` +
        `${initialized.agentInfo?.version || ""}`.trim(),
      );
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      logError("[Hermes ACP] Invalid JSON-RPC frame:", error);
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleAgentRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "session/update") {
      const sessionId = message.params?.sessionId;
      const handlers = this.sessionHandlers.get(sessionId);
      if (handlers) {
        for (const handler of handlers) handler(message.params.update);
      }
      return;
    }

    if (message.method) {
      log(`[Hermes ACP] Ignoring notification ${message.method}`);
    }
  }

  async handleAgentRequest(message) {
    if (message.method !== "session/request_permission") {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported client method: ${message.method}` },
      });
      return;
    }

    // The previous SDK integration ran with bypassPermissions. Preserve that
    // behavior by selecting the broadest allow option Hermes offers.
    const optionId = selectPermissionOption(message.params?.options);
    const outcome = optionId
      ? { outcome: "selected", optionId }
      : { outcome: "cancelled" };
    this.write({ jsonrpc: "2.0", id: message.id, result: { outcome } });
  }

  write(message) {
    if (!this.process?.stdin?.writable) {
      throw new Error("Hermes ACP is not connected");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async call(method, params, timeoutMs = CALL_TIMEOUT_MS, { skipEnsureStarted = false } = {}) {
    if (!skipEnsureStarted) await this.ensureStarted();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  subscribe(sessionId, handler) {
    let handlers = this.sessionHandlers.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      this.sessionHandlers.set(sessionId, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.sessionHandlers.delete(sessionId);
    };
  }

  async openSession({ sessionId, cwd }) {
    await this.ensureStarted();
    if (sessionId) {
      if (!this.openSessions.has(sessionId)) {
        const result = await this.call("session/load", {
          sessionId,
          cwd,
          mcpServers: [],
        });
        if (result == null) {
          throw new Error(`Hermes session ${sessionId} no longer exists`);
        }
        this.openSessions.add(sessionId);
        this.sessionMetadata.set(sessionId, { ...result, cwd });
      }
      return { sessionId, ...this.sessionMetadata.get(sessionId), resumed: true };
    }

    const result = await this.call("session/new", { cwd, mcpServers: [] }, 60_000);
    if (!result?.sessionId) {
      throw new Error("Hermes ACP returned an empty session id");
    }
    this.openSessions.add(result.sessionId);
    this.sessionMetadata.set(result.sessionId, { ...result, cwd });
    return { ...result, resumed: false };
  }

  async setModel(sessionId, modelId) {
    await this.call("session/set_model", { sessionId, modelId });
    const result = await this.call("session/load", {
      sessionId,
      cwd: this.sessionMetadata.get(sessionId)?.cwd || process.env.HOME,
      mcpServers: [],
    });
    if (result == null) {
      throw new Error(`Hermes session ${sessionId} no longer exists`);
    }
    const metadata = { ...result, cwd: this.sessionMetadata.get(sessionId)?.cwd };
    this.sessionMetadata.set(sessionId, metadata);
    return { sessionId, ...metadata, resumed: true };
  }

  async prompt(sessionId, prompt, onUpdate) {
    const unsubscribe = this.subscribe(sessionId, onUpdate);
    try {
      return await this.call("session/prompt", { sessionId, prompt }, 0x7fffffff);
    } finally {
      unsubscribe();
    }
  }

  async steer(sessionId, prompt) {
    return this.call("session/prompt", { sessionId, prompt }, 30_000);
  }

  cancel(sessionId) {
    this.notify("session/cancel", { sessionId });
  }

  handleExit(error) {
    if (!this.process) return;
    logError("[Hermes ACP] Connection closed:", errorMessage(error));
    this.process = null;
    this.openSessions.clear();
    this.sessionMetadata.clear();
    this.rejectPending(error);
  }

  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  stop() {
    const child = this.process;
    this.process = null;
    this.openSessions.clear();
    this.sessionMetadata.clear();
    this.sessionHandlers.clear();
    this.rejectPending(new Error("Hermes ACP stopped"));
    if (child) {
      child.stdin?.end();
      child.kill();
    }
  }
}

export const hermesAcpClient = new HermesAcpClient();
