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
