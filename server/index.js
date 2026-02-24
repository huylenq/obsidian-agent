import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { log } from "./log.js";
import authMiddleware from "./middleware/auth.js";
import healthRouter from "./routes/health.js";
import chatRouter from "./routes/chat.js";
import historyRouter from "./routes/history.js";
import sessionsRouter from "./routes/sessions.js";

const PORT = process.env.PORT || 27182;

// Vault path: server lives at <vault>/.obsidian/plugins/claude-agent/server/
const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = resolve(__dirname, "..", "..", "..", "..");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(authMiddleware);

// Inject server-side vault path into all requests
app.use((req, _res, next) => {
  req.vaultPath = VAULT_PATH;
  next();
});

app.use(healthRouter);
app.use(chatRouter);
app.use(historyRouter);
app.use(sessionsRouter);

app.listen(PORT, () => {
  log(`[Claude Agent Proxy] Running on http://localhost:${PORT}`);
  log(`[Claude Agent Proxy] Health check: http://localhost:${PORT}/health`);
});
