import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { log, logError } from "./log.js";
import authMiddleware from "./middleware/auth.js";
import healthRouter from "./routes/health.js";
import chatRouter from "./routes/chat.js";
import historyRouter from "./routes/history.js";
import sessionsRouter from "./routes/sessions.js";
import indexRouter from "./routes/index.js";
import { connect, getOrCreateTable } from "./embeddings/lanceIndex.js";
import { buildIndex } from "./embeddings/indexer.js";

const PORT = process.env.PORT || 27182;

// Vault path: server lives at <vault>/.obsidian/plugins/claude-agent/server/
const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = resolve(__dirname, "..", "..", "..", "..");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(authMiddleware);

// --- LanceDB initialization ---
let lanceTable = null;

async function initLanceDB() {
  try {
    const dbPath = join(VAULT_PATH, ".obsidian", "lance");
    log("[LanceDB] Connecting to", dbPath);
    const db = await connect(dbPath);
    lanceTable = await getOrCreateTable(db);
    log("[LanceDB] Table ready");

    // Background index build on startup
    if (process.env.OPENAI_API_KEY) {
      buildIndex(VAULT_PATH, lanceTable).catch((err) =>
        logError("[LanceDB] Background index failed:", err)
      );
    } else {
      log("[LanceDB] OPENAI_API_KEY not set — indexing disabled");
    }
  } catch (err) {
    logError("[LanceDB] Init failed:", err);
  }
}

// Inject server-side vault path and lance table into all requests
app.use((req, _res, next) => {
  req.vaultPath = VAULT_PATH;
  req.lanceTable = lanceTable;
  next();
});

app.use(healthRouter);
app.use(chatRouter);
app.use(historyRouter);
app.use(sessionsRouter);
app.use(indexRouter);

// Init LanceDB then start listening
initLanceDB().then(() => {
  app.listen(PORT, () => {
    log(`[Claude Agent Proxy] Running on http://localhost:${PORT}`);
    log(`[Claude Agent Proxy] Health check: http://localhost:${PORT}/health`);
  });
});
