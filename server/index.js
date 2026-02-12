import express from "express";
import cors from "cors";
import { log } from "./log.js";
import authMiddleware from "./middleware/auth.js";
import healthRouter from "./routes/health.js";
import chatRouter from "./routes/chat.js";
import historyRouter from "./routes/history.js";
import sessionsRouter from "./routes/sessions.js";

const PORT = process.env.PORT || 27182;

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(authMiddleware);

app.use(healthRouter);
app.use(chatRouter);
app.use(historyRouter);
app.use(sessionsRouter);

app.listen(PORT, () => {
  log(`[Claude Agent Proxy] Running on http://localhost:${PORT}`);
  log(`[Claude Agent Proxy] Health check: http://localhost:${PORT}/health`);
});
