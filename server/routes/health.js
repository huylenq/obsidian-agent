import { Router } from "express";

const router = Router();

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    provider: "hermes-acp",
    transport: { chat: "websocket", path: "/bridge" },
    capabilities: { streamingInput: true, sessionResume: true },
  });
});

export default router;
