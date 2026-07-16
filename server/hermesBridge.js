import { WebSocket, WebSocketServer } from "ws";
import { ChatSession } from "./chatSession.js";
import { hermesAcpClient } from "./hermesAcpClient.js";
import { log, logError } from "./log.js";

const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      logError("[Hermes Bridge] Failed to send WebSocket message:", error);
    }
  }
}

function sendResult(socket, id, result) {
  send(socket, { jsonrpc: "2.0", id, result });
}

function sendError(socket, id, code, message) {
  send(socket, { jsonrpc: "2.0", id, error: { code, message } });
}

function emitChatEvent(socket, chatId, event) {
  send(socket, {
    jsonrpc: "2.0",
    method: "chat/event",
    params: { chatId, event },
  });
}

function requireChat(state, chatId) {
  const chat = state.chats.get(chatId);
  if (!chat) throw new Error("Chat not found or no longer active");
  return chat;
}

export async function handleBridgeRequest(
  socket,
  state,
  message,
  vaultPath,
  acpClient = hermesAcpClient,
) {
  const { id, method, params = {} } = message;
  if (message.jsonrpc !== "2.0" || id === undefined || typeof method !== "string") {
    sendError(socket, id ?? null, -32600, "Invalid JSON-RPC request");
    return;
  }

  if (method === "bridge/authenticate") {
    if (state.authenticated) {
      sendResult(socket, id, { authenticated: true });
      return;
    }
    if (params.authToken !== process.env.AUTH_TOKEN) {
      sendError(socket, id, 401, "Unauthorized");
      socket.close(1008, "Unauthorized");
      return;
    }
    state.authenticated = true;
    sendResult(socket, id, { authenticated: true });
    return;
  }

  if (!state.authenticated) {
    sendError(socket, id, 401, "Authenticate before using the Hermes bridge");
    return;
  }

  switch (method) {
    case "bridge/ping":
      sendResult(socket, id, { ok: true });
      return;

    case "session/models": {
      const opened = await acpClient.openSession({
        sessionId: params.sessionId || undefined,
        cwd: vaultPath,
      });
      sendResult(socket, id, opened);
      return;
    }

    case "session/set-model": {
      if (!params.sessionId || !params.modelId) {
        throw new Error("sessionId and modelId are required");
      }
      await acpClient.openSession({ sessionId: params.sessionId, cwd: vaultPath });
      const updated = await acpClient.setModel(params.sessionId, params.modelId);
      sendResult(socket, id, updated);
      return;
    }

    case "chat/start": {
      const { chatId, request } = params;
      if (!chatId || typeof chatId !== "string") {
        throw new Error("chatId is required");
      }
      if (!request?.message && !request?.images?.length) {
        throw new Error("Message or images required");
      }
      if (state.chats.has(chatId)) {
        throw new Error(`Chat ${chatId} is already active`);
      }

      const chat = new ChatSession({
        id: chatId,
        request,
        vaultPath,
        onEvent: (event) => emitChatEvent(socket, chatId, event),
      });
      state.chats.set(chatId, chat);
      sendResult(socket, id, { chatId, started: true });
      void chat.run().finally(() => state.chats.delete(chatId));
      return;
    }

    case "chat/inject": {
      const chat = requireChat(state, params.chatId);
      await chat.inject(params);
      sendResult(socket, id, { injected: true });
      return;
    }

    case "chat/interrupt": {
      const chat = requireChat(state, params.chatId);
      const interrupted = await chat.interrupt();
      sendResult(socket, id, { interrupted });
      return;
    }

    default:
      sendError(socket, id, -32601, `Unknown bridge method: ${method}`);
  }
}

export function attachHermesBridge(server, { vaultPath }) {
  const bridge = new WebSocketServer({
    server,
    path: "/bridge",
    maxPayload: MAX_MESSAGE_BYTES,
  });

  bridge.on("connection", (socket) => {
    const state = {
      authenticated: !process.env.AUTH_TOKEN,
      chats: new Map(),
    };

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Binary frames are not supported");
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendError(socket, null, -32700, "Invalid JSON");
        return;
      }

      void handleBridgeRequest(socket, state, message, vaultPath).catch((error) => {
        logError("[Hermes Bridge] Request failed:", error);
        sendError(socket, message.id ?? null, -32000, errorMessage(error));
      });
    });

    socket.on("close", () => {
      for (const chat of state.chats.values()) {
        void chat.interrupt().catch(() => {});
      }
      state.chats.clear();
    });

    socket.on("error", (error) => {
      logError("[Hermes Bridge] WebSocket error:", error);
    });
  });

  bridge.on("listening", () => {
    log("[Hermes Bridge] WebSocket endpoint ready at /bridge");
  });

  return bridge;
}
