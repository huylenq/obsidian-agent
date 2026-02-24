import { Router } from "express";

const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok", capabilities: { streamingInput: true } });
});

export default router;
