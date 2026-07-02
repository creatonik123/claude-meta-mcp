/**
 * Execution wiring: connects guard + doer + audit to the live MCP server.
 *
 * Master gate: resolveExecutionEnabled (default OFF). While off, wireExecution
 * returns immediately — no DB client, no audit sink, no write tools registered;
 * the server surface is identical to the read-only build. When on, the boot
 * guard verifies every dependency (or refuses to start), and the three gated
 * write tools register. Each call then runs the full chain:
 *   guard decision (audited) -> doer execute + read-back verify -> outcome audited.
 * Second, independent lock: the guard's per-action modes (guard.config.json)
 * all ship 'off' and assertShipInvariants enforces that at boot — so even with
 * the env flag on, every call is refused until a reviewed config change flips a
 * mode. Refusals return as structured JSON, never thrown errors (PRD R3).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionType, GuardConfig, GuardDeps } from "./guard.js";
import type { DoerDeps, ExecutionCoordinator } from "./doer.js";
import type { AuditSink } from "./audit.js";
import type { ToolRegistrar } from "./read-only-gate.js";
import { runGuardedDecision } from "./guarded-action.js";
import { executeAndAudit } from "./execute-and-audit.js";
import { resolveExecutionEnabled, assertExecutionBootSafe } from "./execution-config.js";
import { createNeonSql } from "./sql.js";
import { createGuardDb } from "./guard-db.js";
import { createGuardMeta } from "./guard-meta.js";
import { createMetaWriter, createMetaReader, type GraphClient } from "./meta-adapters.js";
import { createDbCoordinator } from "./coordinator-db.js";
import { createDbAuditSink } from "./audit-db.js";

// Tool names (what the MCP menu shows) -> guard action types. The sets must not
// drift: a test asserts keys === GATED_WRITE_TOOLS (see tool-gate.ts note).
export const TOOL_TO_ACTION: Record<string, ActionType> = {
  pause_entity: "pause",
  adjust_adset_budget: "adjust_adset_budget",
  publish_approved_creative: "publish_approved_creative",
};

// Minor units per major unit, by account currency. Known currencies ONLY — a
// guessed offset could mis-budget by up to 100x, so anything else refuses.
const CURRENCY_OFFSETS: Record<string, number> = { AUD: 100 };

export function currencyOffsetFor(currency: string | undefined): number {
  const offset = currency ? CURRENCY_OFFSETS[currency] : undefined;
  if (offset === undefined) {
    throw new Error(`unknown currency '${String(currency)}' — refusing to derive a minor-units offset`);
  }
  return offset;
}

export interface ExecutionDeps {
  guardDeps: GuardDeps;
  doerDeps: DoerDeps;
  audit: AuditSink;
  holder: string;
}

// The MCP server is long-lived, but the doer's dedupe was designed per RUN: a
// later run must be able to re-apply the same value (re-pause a reactivated ad,
// re-set a drifted budget). With a per-boot holder alone, a server that stays up
// for weeks would keep skipping those as "already applied". Scoping the dedupe
// key to the account-tz day restores the intent: same-day double-writes dedupe,
// any later day may re-apply. Locks keep the boot-stable holder (safe release).
export function withDayScopedDedupe(inner: ExecutionCoordinator, day: () => string): ExecutionCoordinator {
  return {
    acquire: (lockKey) => inner.acquire(lockKey),
    release: (lockKey) => inner.release(lockKey),
    // async so a day() throw becomes a rejection: the doer treats it as a
    // failed idempotency check and refuses to write (fail-closed).
    alreadyApplied: async (dedupeKey) => inner.alreadyApplied(`${day()}:${dedupeKey}`),
    markApplied: async (dedupeKey) => inner.markApplied(`${day()}:${dedupeKey}`),
  };
}

// Same day computation the guard uses (account tz, never UTC). The config's
// timezone is IANA-validated at load, so a throw here is unexpected — and the
// wrapper above turns it into a refused write, never a wrong-day dedupe.
function accountDay(timeZone: string): string {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`could not resolve account-tz date (got '${s}')`);
  }
  return s;
}

// Construct every live dependency of the execution path. Fail-closed: a missing
// connection string or unknown currency throws (and, at boot, aborts startup).
export function buildExecutionDeps(
  env: Record<string, string | undefined>,
  client: GraphClient,
  guardConfig: GuardConfig
): ExecutionDeps {
  const currencyOffset = currencyOffsetFor(guardConfig.currency);
  const sql = createNeonSql(env.DATABASE_URL);
  const holder = `mcp-${randomUUID()}`; // per-boot-unique: owns locks; dedupe is day-scoped below
  return {
    guardDeps: {
      config: guardConfig,
      now: () => new Date(),
      env,
      db: createGuardDb(sql),
      meta: createGuardMeta(client, guardConfig.managedAccountId, currencyOffset),
    },
    doerDeps: {
      executionEnabled: true, // reached only behind resolveExecutionEnabled
      writer: createMetaWriter(client),
      reader: createMetaReader(client),
      coordinator: withDayScopedDedupe(createDbCoordinator(sql, holder), () =>
        accountDay(guardConfig.accountTimezone)
      ),
      currencyOffset,
    },
    audit: createDbAuditSink(sql),
    holder,
  };
}

// The guard args are CONSTRUCTED from schema-validated named fields — extra
// fields a caller smuggles in never reach the guard or the write path.
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  guardArgs: (args: Record<string, unknown>) => Record<string, unknown>;
}> = [
  {
    name: "pause_entity",
    description:
      "Pause an ad or ad set on the managed account. Guarded: kill switch, action mode, account scope and audit apply; refusals return structured reasons.",
    inputSchema: { entityId: z.string().min(1).describe("Ad or ad set id") },
    guardArgs: (a) => ({ entityId: str(a.entityId), status: "PAUSED" }),
  },
  {
    name: "adjust_adset_budget",
    description:
      "Set an ad set's daily budget in major account-currency units (e.g. AUD dollars). Guarded: clamps, account caps, spend caps and audit apply; the clamped value is what gets written.",
    inputSchema: {
      entityId: z.string().min(1).describe("Ad set id"),
      dailyBudget: z.number().describe("Requested daily budget, major units"),
    },
    guardArgs: (a) => ({ entityId: str(a.entityId), dailyBudget: a.dailyBudget }),
  },
  {
    name: "publish_approved_creative",
    description:
      "Publish a creative that has an immutable, unconsumed approval record. Guarded: refused unless the approval exists and is unused.",
    inputSchema: { approvalHash: z.string().min(1).describe("Approval record hash") },
    guardArgs: (a) => ({ approvalHash: str(a.approvalHash) }),
  },
];

export function registerGatedWriteTools(
  mcp: ToolRegistrar,
  deps: Pick<ExecutionDeps, "guardDeps" | "doerDeps" | "audit">
): string[] {
  const registered: string[] = [];
  for (const def of TOOL_DEFS) {
    const action = TOOL_TO_ACTION[def.name];
    mcp.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      async (args: Record<string, unknown>) => {
        // Decision first (always audited); execution only on an allow. An
        // unlogged allow is downgraded to a refusal inside runGuardedDecision.
        const decision = await runGuardedDecision(action, def.guardArgs(args ?? {}), deps.guardDeps, deps.audit);
        const outcome = decision.allowed
          ? await executeAndAudit(action, decision, deps.doerDeps, deps.audit, deps.guardDeps.now)
          : null;
        const payload = {
          decision,
          execution: outcome?.execution ?? null,
          audited: outcome?.audited ?? null,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      }
    );
    registered.push(def.name);
  }
  return registered;
}

export function wireExecution(
  mcp: ToolRegistrar,
  opts: {
    env: Record<string, string | undefined>;
    client: GraphClient;
    guardConfig: GuardConfig;
  }
): { enabled: boolean; tools: string[]; holder?: string } {
  if (!resolveExecutionEnabled(opts.env)) {
    return { enabled: false, tools: [] }; // recommend-only: nothing constructed
  }
  const built = buildExecutionDeps(opts.env, opts.client, opts.guardConfig);
  assertExecutionBootSafe(opts.env, {
    writer: built.doerDeps.writer,
    reader: built.doerDeps.reader,
    coordinator: built.doerDeps.coordinator,
    currencyOffset: built.doerDeps.currencyOffset,
  });
  const tools = registerGatedWriteTools(mcp, built);
  return { enabled: true, tools, holder: built.holder };
}
