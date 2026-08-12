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
import type { ActionType, GuardConfig, GuardDb, GuardDeps } from "./guard.js";
import type { DoerDeps, ExecutionCoordinator, PublishWiring } from "./doer.js";
import type { Sql } from "./coordinator-db.js";
import type { AuditSink } from "./audit.js";
import type { ToolRegistrar } from "./read-only-gate.js";
import { runGuardedDecision } from "./guarded-action.js";
import { executeAndAudit } from "./execute-and-audit.js";
import { resolveExecutionEnabled, assertExecutionBootSafe } from "./execution-config.js";
import { createNeonSql } from "./sql.js";
import { createGuardDb } from "./guard-db.js";
import { createGuardMeta } from "./guard-meta.js";
import { createMetaWriter, createMetaReader, createPublisherGraph, type GraphClient } from "./meta-adapters.js";
import { createDbCoordinator } from "./coordinator-db.js";
import { createDbAuditSink } from "./audit-db.js";
import { createPublishDb } from "./publish-db.js";
import { createMetaPublisher } from "./meta-publisher.js";

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
  // Per-call account-wide budget lock (see ACCOUNT_BUDGET_LOCK). Each call gets
  // its OWN holder so releasing after a lease-expiry takeover cannot delete a
  // successor's lock, and its own lease sized to the guard's worst-case span.
  accountLock: () => { acquire: () => Promise<boolean>; release: () => Promise<void> };
}

// The account budget lock is held across the guard's Meta reads (entity owner,
// current budget, up to 10 live-total pages, realised spend — each bounded by
// the client's 30s timeout) plus the doer's ~60s write+read-back, so its lease
// must outlast that whole span: ~460s worst case, 900s = ~2x margin. The
// coordinator's default 120s lease is calibrated for the doer-only section and
// MUST NOT be used for this lock.
export const ACCOUNT_LOCK_TTL_SECONDS = 900;

// The MCP server is long-lived, but the doer's dedupe was designed per RUN: a
// later run must be able to re-apply the same value (re-pause a reactivated ad,
// re-set a drifted budget). With a per-boot holder alone, a server that stays up
// for weeks would keep skipping those as "already applied". Scoping the dedupe
// key to the account-tz day restores the intent: same-day double-writes dedupe,
// any later day may re-apply. Locks keep the boot-stable holder (safe release).
export function withDayScopedDedupe(
  inner: ExecutionCoordinator,
  day: () => string
): ExecutionCoordinator & { dayScoped: true } {
  return {
    // marker so composition tests can assert the wrapper is actually applied
    dayScoped: true,
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

/**
 * Assemble the publish path from its five pieces. Until this existed, an ALLOWED publish returned
 * "publish is not wired on this deployment" — correct fail-closed behaviour, and the reason nothing
 * could ever be created.
 *
 * TWO CHOICES HERE ARE SAFETY PROPERTIES, NOT PLUMBING:
 *
 * 1. `approvalByHash` is the GUARD'S OWN reader, passed by reference rather than rebuilt. The guard
 *    decides whether the approval is spendable; the doer re-reads it immediately before the write to
 *    narrow the window in which another run consumed it. If those two ever read the approval
 *    differently — one consulting approval_consumptions, the other not — the re-read would bless an
 *    approval the guard would have refused. Sharing the instance makes divergence impossible rather
 *    than merely untrue today.
 *
 * 2. The publisher files against `guardConfig.managedAccountId`, never `env.META_AD_ACCOUNT_ID`.
 *    That env var holds the PRODUCTION account (the app reads it by design for reporting); the write
 *    path may only ever touch the sandbox. Taking the account from the reviewed config means the
 *    account that was allowlisted is the account that gets written to.
 *
 * Not added to `assertExecutionBootSafe` deliberately: publish is the least essential of the three
 * write tools, and refusing to boot over it would also take down pause and budget — the two writes
 * the zero-spend smoke test and the A$75 test actually need. A half-wired publish already degrades to
 * a structured no-write in `runPublish` (`DoerDeps.publish` is optional for exactly this reason).
 */
export function buildPublishWiring(
  sql: Sql,
  client: GraphClient,
  guardConfig: GuardConfig,
  guardDb: GuardDb
): PublishWiring {
  const publishDb = createPublishDb(sql);
  const graph = createPublisherGraph(client);
  return {
    approvalByHash: guardDb.approvalByHash,
    publisher: createMetaPublisher({
      accountId: guardConfig.managedAccountId,
      post: graph.post,
      get: graph.get,
      readComposition: (h) => publishDb.readComposition(h),
      readAsset: (s) => publishDb.readAsset(s),
    }),
    consumeApproval: (h, ref) => publishDb.consumeApproval(h, ref),
  };
}

// Construct every live dependency of the execution path. Fail-closed: a missing
// connection string or unknown currency throws (and, at boot, aborts startup).
export function buildExecutionDeps(
  env: Record<string, string | undefined>,
  client: GraphClient,
  guardConfig: GuardConfig,
  // injectable ONLY so tests can pin the holder/lease each coordinator is
  // built with (a plain object-identity check cannot observe either)
  createCoord: typeof createDbCoordinator = createDbCoordinator
): ExecutionDeps {
  const currencyOffset = currencyOffsetFor(guardConfig.currency);
  const sql = createNeonSql(env.DATABASE_URL);
  const holder = `mcp-${randomUUID()}`; // per-boot-unique: owns locks; dedupe is day-scoped below
  let lockSeq = 0;
  const accountLock = () => {
    // fresh holder per call: after a lease-expiry takeover, this call's release
    // matches only its own row and cannot delete the takeover's lock
    const c = createCoord(sql, `${holder}:albk:${++lockSeq}`, ACCOUNT_LOCK_TTL_SECONDS);
    return {
      acquire: () => c.acquire(ACCOUNT_BUDGET_LOCK),
      release: () => c.release(ACCOUNT_BUDGET_LOCK),
    };
  };
  // ONE instance, shared: the guard decides on the approval and the doer re-reads it at write
  // time. Two separately-built readers could drift and nothing would notice.
  const guardDb = createGuardDb(sql);
  return {
    accountLock,
    guardDeps: {
      config: guardConfig,
      now: () => new Date(),
      env,
      db: guardDb,
      meta: createGuardMeta(client, guardConfig.managedAccountId, currencyOffset),
    },
    doerDeps: {
      executionEnabled: true, // reached only behind resolveExecutionEnabled
      writer: createMetaWriter(client),
      reader: createMetaReader(client),
      coordinator: withDayScopedDedupe(createCoord(sql, holder), () =>
        accountDay(guardConfig.accountTimezone)
      ),
      currencyOffset,
      publish: buildPublishWiring(sql, client, guardConfig, guardDb),
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

// One lock key serializes every budget decision+write on the account. The
// guard's cumulative account cap is check-then-act over a LIVE total read, so
// two concurrent budget decisions could each observe the pre-write total and
// jointly exceed the day ceiling; holding this lock across the whole
// decide->execute span closes that race.
export const ACCOUNT_BUDGET_LOCK = "account_budget";

export function registerGatedWriteTools(
  mcp: ToolRegistrar,
  deps: Pick<ExecutionDeps, "guardDeps" | "doerDeps" | "audit" | "accountLock">
): string[] {
  const registered: string[] = [];

  const decideAndExecute = async (action: ActionType, guardArgs: Record<string, unknown>) => {
    // Decision first (always audited); execution only on an allow. An
    // unlogged allow is downgraded to a refusal inside runGuardedDecision.
    const decision = await runGuardedDecision(action, guardArgs, deps.guardDeps, deps.audit);
    const outcome = decision.allowed
      ? await executeAndAudit(action, decision, deps.doerDeps, deps.audit, deps.guardDeps.now)
      : null;
    const payload = {
      decision,
      execution: outcome?.execution ?? null,
      audited: outcome?.audited ?? null,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  };

  const refuseLocked = async (
    action: ActionType,
    guardArgs: Record<string, unknown>,
    code: string,
    reason: string
  ) => {
    const decision = { allowed: false as const, code, reason };
    let ts: string;
    try {
      ts = deps.guardDeps.now().toISOString();
    } catch {
      ts = "unknown";
    }
    try {
      await deps.audit.write({
        ts,
        actor: "agent",
        action: "adjust_adset_budget",
        entityId: typeof guardArgs.entityId === "string" ? guardArgs.entityId : null,
        ruleTriggered: decision.code,
        result: "refused",
        details: { reason: decision.reason },
      });
    } catch {
      // the refusal stands whether or not it could be logged
    }
    return { content: [{ type: "text", text: JSON.stringify({ decision, execution: null, audited: null }) }] };
  };

  for (const def of TOOL_DEFS) {
    const action = TOOL_TO_ACTION[def.name];
    mcp.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      async (args: Record<string, unknown>) => {
        const guardArgs = def.guardArgs(args ?? {});
        if (action !== "adjust_adset_budget") {
          return decideAndExecute(action, guardArgs);
        }
        const lock = deps.accountLock();
        // Two distinct refusals, both fail-closed: a store outage must not be
        // audited as contention (they need different operator responses).
        let locked: boolean;
        try {
          locked = await lock.acquire();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return refuseLocked(action, guardArgs, "account_lock_unavailable", `could not reach the budget lock store — refused (fail-closed): ${msg}`);
        }
        if (!locked) {
          return refuseLocked(
            action,
            guardArgs,
            "account_budget_locked",
            "another budget change is being decided or applied — serialized for the account cap, retry shortly"
          );
        }
        try {
          return await decideAndExecute(action, guardArgs);
        } finally {
          try {
            await lock.release();
          } catch {
            // lease expiry reclaims an unreleased lock
          }
        }
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
