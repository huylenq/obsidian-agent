/**
 * Auth middleware for Claude Agent Proxy
 *
 * If AUTH_TOKEN is set in environment:
 * - Validates Bearer token on all routes except GET /health
 * - Returns 401 if token is missing or invalid
 *
 * If AUTH_TOKEN is NOT set:
 * - Passes through all requests (backward compatible)
 */

const AUTH_TOKEN = process.env.AUTH_TOKEN;

export default function authMiddleware(req, res, next) {
  // No auth token configured - skip authentication
  if (!AUTH_TOKEN) {
    return next();
  }

  // Allow unauthenticated health checks and index status
  if (req.method === "GET" && (req.path === "/health" || req.path === "/index/status")) {
    return next();
  }

  // Extract token from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix

  // Validate token
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
