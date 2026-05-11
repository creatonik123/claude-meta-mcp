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

const VERSION = "0.4.0";

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

async function main(): Promise<void> {
  const meta = new MetaClient(config.meta.accessToken, config.meta.apiVersion);
  const mcp = new McpServer({
    name: "claude-meta-mcp",
    version: VERSION,
  });
  registerTools(mcp, meta);
  registerWriteTools(mcp, meta);
  registerInstagramTools(mcp, meta);
  registerCatalogTools(mcp, meta);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "claude-meta-mcp",
      version: VERSION,
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

  app.listen(config.port, () => {
    log("info", "claude-meta-mcp listening", {
      port: config.port,
      version: VERSION,
      public_url: config.publicUrl,
      meta_api_version: config.meta.apiVersion,
    });
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
