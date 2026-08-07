/**
 * Vercel serverless entry point.
 *
 * The MCP transport runs in STATELESS mode (`sessionIdGenerator: undefined` in
 * src/index.ts), so every request is self-contained — which is exactly what a
 * function-per-request platform provides. Nothing here changes the server's
 * behaviour; it only hands Vercel the Express request handler instead of
 * binding a port.
 *
 * The app is built once per warm instance and reused. Building it re-runs every
 * startup assertion (ship invariants, read-only gate, safe-tool registration),
 * so a misconfigured deploy fails closed on its first request rather than
 * serving a half-guarded server.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/index.js";

// Cache the PROMISE, not the resolved app: two concurrent cold requests would
// otherwise each build their own server. If construction fails, drop the cache
// so the next request retries instead of returning a poisoned rejection forever.
let appPromise: ReturnType<typeof createApp> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    if (!appPromise) {
      appPromise = createApp();
      appPromise.catch(() => { appPromise = null; });
    }
    const app = await appPromise;
    return (app as unknown as (q: IncomingMessage, s: ServerResponse) => void)(req, res);
  } catch (err) {
    // A startup failure must never look like a successful, unguarded server.
    const message = err instanceof Error ? err.message : String(err);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "startup_failed", message }));
  }
}
