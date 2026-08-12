#!/usr/bin/env node
/**
 * claude-meta-mcp — entry point.
 *
 * Boots an Express server that exposes:
 *   - GET  /health        liveness probe
 *   - POST /mcp           MCP Streamable HTTP transport (Bearer-auth gated)
 *
 * v0.1 single-tenant: one shared Meta access token, one shared Bearer auth
 * token. Multi-tenant + OAuth 2.1 + DCR is planned for v0.2.
 */

import { pathToFileURL } from "node:url";
import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.js";
import { MetaClient } from "./meta-client.js";
import { MetaApiError } from "./meta-client.js";
import { registerTools } from "./tools.js";
import { registerWriteTools } from "./tools-write.js";
import { registerInstagramTools } from "./tools-instagram.js";
import { registerCatalogTools } from "./tools-catalogs.js";
import { installReadOnlyGate } from "./read-only-gate.js";
import { assertSafeToolRegistration } from "./startup-assert.js";
import { loadGuardConfig, assertShipInvariants } from "./load-config.js";
import { resolveExecutionEnabled } from "./execution-config.js";
import { wireExecution } from "./execution-wiring.js";
import { VERSION, buildInfo } from "./version.js";

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  };
  // stderr keeps stdout clean for the (unused) stdio transport
  console.error(JSON.stringify(line));
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1] !== config.authToken) {
    log("warn", "rejected unauthenticated MCP request", {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({
      error: "unauthorized",
      message: "Missing or invalid Bearer token",
    });
    return;
  }
  next();
}

/**
 * Build the fully-wired Express app WITHOUT binding a port.
 *
 * Split out from `main()` so the identical server can run two ways:
 *   - as a long-lived process (`npm start`), which calls listen() below, and
 *   - as a serverless function, which just needs the request handler.
 *
 * This is safe precisely because the MCP transport is STATELESS here
 * (`sessionIdGenerator: undefined`): a fresh transport is created per request
 * and closed with the response, so nothing is held in memory between calls and
 * there is no session affinity to lose. Every startup assertion — ship
 * invariants, the read-only gate, the safe-registration backstop — still runs
 * before the app is returned, so a cold start fails closed exactly like a boot.
 */
export async function createApp(): Promise<express.Express> {
  // Load + validate the guard config and enforce the recommend-only ship
  // state (all action modes 'off', forbidden account on the deny list).
  // A malformed config or an unsafe mode aborts startup (fail closed).
  const guardConfig = loadGuardConfig();
  assertShipInvariants(guardConfig);
  log("info", "guard config loaded; recommend-only ship invariants OK", {
    managed_account: guardConfig.managedAccountId,
    action_modes: guardConfig.actionModes,
  });

  const meta = new MetaClient(config.meta.accessToken, config.meta.apiVersion);
  const mcp = new McpServer({
    name: "claude-meta-mcp",
    version: VERSION,
  });
  // Install the read-only safety gate BEFORE registering anything: only
  // READ_ALLOWLIST names actually register (plus, when the execution flag is
  // on, the 3 guard-gated write tools); every other write tool the register*
  // functions attempt is refused and logged.
  const executionEnabled = resolveExecutionEnabled(process.env);
  const { attempted, registered } = installReadOnlyGate(
    mcp,
    (name) => log("warn", "tool registration refused by AdPilot safety gate (write/unlisted)", { tool: name }),
    { allowGatedWrites: executionEnabled }
  );

  registerTools(mcp, meta);
  registerWriteTools(mcp, meta);
  registerInstagramTools(mcp, meta);
  registerCatalogTools(mcp, meta);

  // Execution wiring — master flag default OFF. While off this constructs and
  // registers NOTHING (surface identical to the read-only build). When on, it
  // builds the guard/doer/audit deps (fail-closed), runs the execution boot
  // guard, and registers the 3 gated write tools. Even then, every call is
  // still refused until guard.config.json action modes leave 'off' — which
  // assertShipInvariants above forbids in this ship state.
  const execution = wireExecution(mcp, { env: process.env, client: meta, guardConfig });

  // Boot-time backstop: refuse to start if any REGISTERED (callable) tool is a
  // write that is not a guarded write — independent of the read allow-list, so
  // it fires even if the gate breaks or a write name is wrongly allow-listed.
  assertSafeToolRegistration(registered);

  log("info", execution.enabled ? "AdPilot execution wiring ACTIVE (guard-gated writes registered)" : "AdPilot read-only mode active", {
    registered_count: registered.length,
    attempted_count: attempted.length,
    registered_tools: registered,
    execution_enabled: execution.enabled,
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "claude-meta-mcp",
      ...buildInfo(process.env),
      meta_api_version: config.meta.apiVersion,
    });
  });

  app.post("/mcp", bearerAuth, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error", "MCP request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        if (err instanceof MetaApiError) {
          res.status(502).json({
            error: "meta_api_error",
            meta: err.meta,
          });
        } else {
          res.status(500).json({
            error: "internal_error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
    }
  });

  // Reject anything else with a hint
  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `${req.method} ${req.path} is not a valid endpoint. Use GET /health or POST /mcp.`,
    });
  });

  return app;
}

async function main(): Promise<void> {
  const app = await createApp();
  app.listen(config.port, () => {
    log("info", "claude-meta-mcp listening", {
      port: config.port,
      version: VERSION,
      public_url: config.publicUrl,
      meta_api_version: config.meta.apiVersion,
    });
  });
}

// Only bind a port when this file is executed directly (`npm start`, `npx`).
// Under a serverless host the module is IMPORTED for its `createApp` export, and
// starting a listener there would either crash the function or leak a socket.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
