/**
 * Real network adapters: bridge the existing Meta Graph client to the doer's
 * MetaWriter / MetaReader ports. Deliberately thin — no retry/backoff here. A
 * thrown write is resolved by the doer's read-back + idempotency, so transient-
 * error backoff stays an orchestration concern, not buried in the write path.
 */
import type { MetaWriter, MetaReader } from "./doer.js";

// The slice of the Meta Graph client these adapters need (MetaClient satisfies it).
export interface GraphClient {
  get<T = unknown>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T = unknown>(path: string, body?: Record<string, string | number | boolean | undefined>): Promise<T>;
}

export function createMetaWriter(client: GraphClient): MetaWriter {
  return { post: (path, body) => client.post(path, body) };
}

export function createMetaReader(client: GraphClient): MetaReader {
  return {
    async get(entityId, fields) {
      return client.get<Record<string, unknown>>(`/${entityId}`, { fields: fields.join(",") });
    },
  };
}

/**
 * The graph port the PUBLISH path needs, which is not the same shape as the writer's.
 *
 * Publish is the only path that sends nested bodies (`object_story_spec`, `creative`).
 * MetaClient.post form-encodes each value with `String(value)`, so a nested object would be
 * transmitted literally as `[object Object]` — Graph's convention for a form-encoded request is
 * one JSON string per nested field, so the encoding has to happen here or not at all.
 *
 * Anything with no unambiguous encoding (null, undefined, NaN, a function) REFUSES rather than
 * being coerced: `String(null)` is the four characters `null`, which Meta would accept as a
 * literal value, and the field being mangled is the copy in a live ad.
 */
export interface PublisherGraph {
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
  get(path: string): Promise<Record<string, unknown>>;
}

function encodeGraphField(key: string, v: unknown): string | number | boolean {
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`meta-adapters: cannot encode body field '${key}' — '${String(v)}' is not a finite number`);
    return v;
  }
  // Plain objects and arrays alike: Graph reads them as JSON text in a form-encoded body.
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  throw new Error(`meta-adapters: cannot encode body field '${key}' — no unambiguous encoding for ${v === null ? "null" : typeof v}`);
}

export function createPublisherGraph(client: GraphClient): PublisherGraph {
  return {
    async post(path, body) {
      // Encode EVERY field before the first network call, so a body we cannot represent is
      // refused instead of half-sent.
      const encoded: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(body ?? {})) encoded[k] = encodeGraphField(k, v);
      return client.post(path, encoded);
    },
    // The path already carries its query string (the ad-list field set). It is passed through
    // verbatim; axios appends `access_token` with `&` when a `?` is already present.
    get(path) {
      return client.get<Record<string, unknown>>(path);
    },
  };
}
