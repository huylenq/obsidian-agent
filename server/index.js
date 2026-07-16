import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import express from "express";
import cors from "cors";
import { log, logError } from "./log.js";
import authMiddleware from "./middleware/auth.js";
import healthRouter from "./routes/health.js";
import historyRouter from "./routes/history.js";
import sessionsRouter from "./routes/sessions.js";
import indexRouter from "./routes/index.js";
import { connect, getOrCreateTable } from "./embeddings/lanceIndex.js";
import { buildIndex } from "./embeddings/indexer.js";
import { hermesAcpClient } from "./hermesAcpClient.js";
import { attachHermesBridge } from "./hermesBridge.js";

const PORT = process.env.PORT || 27182;

// Vault path: bridge lives at <vault>/.obsidian/plugins/<plugin-id>/server/
const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = resolve(__dirname, "..", "..", "..", "..");

const app = express();
const server = createServer(app);
const bridge = attachHermesBridge(server, { vaultPath: VAULT_PATH });

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
app.use(historyRouter);
app.use(sessionsRouter);
app.use(indexRouter);

// Init LanceDB then start listening
initLanceDB().then(() => {
  server.listen(PORT, () => {
    log(`[Hermes Bridge] Running on http://localhost:${PORT}`);
    log(`[Hermes Bridge] Health check: http://localhost:${PORT}/health`);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    bridge.close();
    server.close();
    hermesAcpClient.stop();
    process.exit(0);
  });
}
