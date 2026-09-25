/**
 * Environment configuration loader.
 *
 * Reads required variables from process.env, validates them, and exposes a
 * single typed `config` object for the rest of the codebase.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export const config = {
  port: parseInt(optional("PORT", "3210"), 10),
  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",
  meta: {
    accessToken: required("META_ACCESS_TOKEN"),
    apiVersion: optional("META_API_VERSION", "v23.0"),
  },
  /**
   * Bearer token a client must present in the Authorization header when
   * calling /mcp. In v0.1 (single-tenant), this is a single shared secret.
   * v0.2 will replace this with proper OAuth 2.1 + DCR.
   */
  authToken: required("AUTH_TOKEN"),
  publicUrl: optional("PUBLIC_URL", "http://localhost:3210"),
} as const;

export type Config = typeof config;
