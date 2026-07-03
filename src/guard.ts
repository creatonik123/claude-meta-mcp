/**
 * Write guard: decides allow or refuse for a proposed action (PRD R3, GUARD_DESIGN v3).
 * Never touches Meta itself; the caller acts only when allowed.
 * Deps are injected so it can be tested with fakes (no real Meta/DB/money).
 * Every check fails closed: if anything is unknown or errors, it refuses.
 */

export type ActionType =
  | "pause"
  | "adjust_adset_budget"
  | "publish_approved_creative";

export type ActionMode = "off" | "confirm" | "auto";

export interface CurrentBudget {
  dailyBudget: number | null; // account-currency major units (e.g. AUD)
  lifetimeBudget: number | null;
  ownedByCampaignCbo: boolean;
}

export interface SpendSnapshot {
  today: number; // AUD spent so far today
  monthToDate: number; // AUD spent month-to-date
  dateStop: string; // YYYY-MM-DD the figure covers (account tz)
  complete: boolean; // false if Meta returned an empty/partial page
}

export interface GuardConfig {
  managedAccountId: string;
  deniedAccountIds: string[];
  currency?: string;
  accountTimezone: string; // IANA tz of the ad account (e.g. "Australia/Sydney") — day boundaries follow this, not UTC
  actionModes: Record<ActionType, ActionMode>;
  killSwitchEnvFlag: string;
  budgetClamp: {
    maxSingleChangePct: number;
    maxAccountChangePerDayPct: number;
    blockLifetimeBudgetWrites: boolean;
    blockCboAdsetBudgetWrites: boolean;
    crossDayMaxMultipleVs30dBaseline: number;
  };
  spendCaps: {
    dailyAud: number;
    monthlyAud: number;
    sameDayDecisionFractionOfDailyCap: number;
    spendSnapshotMaxAgeMinutes: number;
    monthEndRevisionBufferAud: number;
  };
  targets: { targetCplAud: number; provisional: boolean };
  schemaVersion: number;
}

export interface GuardDb {
  killSwitchRow(): Promise<boolean | null>; // true=frozen, null=missing/unknown
  schemaVersion(): Promise<number | null>;
  approvalByHash(hash: string): Promise<{ consumed: boolean } | null>;
  startOfDayBudget(entityId: string, day: string): Promise<number | null>;
  accountStartOfDayTotal(day: string): Promise<number | null>;
  // Trailing 30-day budget baseline for the cross-day creep ceiling: the 30
  // account-tz days strictly BEFORE the given day (the anchor day's own
  // snapshot is excluded — it is the value under judgment). Never the DB
  // server's clock, which is UTC. null = no history yet (the creep check is
  // skipped; the per-change, account, and spend caps still apply). A thrown
  // error fails closed.
  budgetBaseline30d(entityId: string, day: string): Promise<number | null>;
}

export interface GuardMeta {
  entityAccountId(entityId: string): Promise<string | null>;
  currentBudget(entityId: string): Promise<CurrentBudget | null>;
  realisedSpend(): Promise<SpendSnapshot | null>;
  // LIVE sum of the account's ACTIVE ad sets' own daily budgets (major units).
  // The account cap compares the projected live total against the frozen
  // start-of-day ceiling, so same-day increases already applied — by the agent
  // or a human — consume the day's headroom. null/unreadable = refuse.
  accountActiveDailyBudgetTotal(): Promise<number | null>;
}

export interface GuardDeps {
  config: GuardConfig;
  now: () => Date;
  env: Record<string, string | undefined>;
  db: GuardDb;
  meta: GuardMeta;
}

export type Decision =
  | { allowed: true; effectiveArgs: Record<string, unknown> }
  | { allowed: false; code: string; reason: string };

const refuse = (code: string, reason: string): Decision => ({
  allowed: false,
  code,
  reason,
});

// Normalize a Meta account id so "123" and "act_123" compare equal.
function canonAccount(id: string | null | undefined): string | null {
  if (typeof id !== "string" || id.trim() === "") return null;
  return id.startsWith("act_") ? id : `act_${id}`;
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

// Calendar date in the ACCOUNT's timezone (not UTC). Start-of-day baselines and
// "spent today" must align with how Meta reports the account, or a decision near
// UTC-midnight reads the wrong day. Throws on an unusable tz (caller fails closed).
function dayString(now: Date, timeZone: string): string {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // en-CA => "YYYY-MM-DD"
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`could not resolve account-tz date (got '${s}')`);
  }
  return s;
}

// Run an async safety read; ANY throw becomes a fail-closed refusal.
async function failClosed<T>(
  fn: () => Promise<T>,
  code: string,
  what: string
): Promise<{ ok: true; value: T } | { ok: false; decision: Decision }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, decision: refuse(code, `${what} read failed (fail-closed): ${msg}`) };
  }
}

// entry point: catch any unexpected error and turn it into a refusal
export async function evaluate(
  action: ActionType,
  args: Record<string, unknown>,
  deps: GuardDeps
): Promise<Decision> {
  try {
    return await evaluateInner(action, args, deps);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return refuse("internal_error", `guard error (fail-closed): ${msg}`);
  }
}

async function evaluateInner(
  action: ActionType,
  args: Record<string, unknown>,
  deps: GuardDeps
): Promise<Decision> {
  const { config, db, meta, env } = deps;

  // 1. Kill switch — env flag (no I/O), authoritative.
  const envFlag = env[config.killSwitchEnvFlag];
  if (envFlag !== undefined && envFlag !== "" && envFlag !== "0" && envFlag !== "false") {
    return refuse("kill_switch_env", "kill switch env flag is set — all writes frozen");
  }

  // 2. Schema version — fail closed on mismatch/unknown.
  const sv = await failClosed(() => db.schemaVersion(), "schema_unreadable", "schema version");
  if (!sv.ok) return sv.decision;
  if (sv.value !== config.schemaVersion) {
    return refuse("schema_mismatch", `schema version ${sv.value} != expected ${config.schemaVersion}`);
  }

  // 3. Kill switch — DB row. Missing/unknown (null) = treat as frozen.
  const ks = await failClosed(() => db.killSwitchRow(), "kill_switch_unreadable", "kill switch row");
  if (!ks.ok) return ks.decision;
  if (ks.value !== false) {
    return refuse("kill_switch_db", "kill switch row is set or missing — writes frozen (fail-closed)");
  }

  // 4. Action mode — strict positive allow. Only "auto" executes here.
  const mode = config.actionModes[action];
  if (mode !== "auto") {
    return refuse(
      "action_mode_off",
      `action '${action}' is in '${mode ?? "unknown"}' mode (recommend-only) — no write`
    );
  }

  // 5. Strict argument allow-list (per action) — validate the EXACT object.
  const argCheck = validateArgs(action, args);
  if (argCheck) return argCheck;

  // 6. Account scope (entity ops) — resolve the TRUE owner from Meta.
  if (action === "pause" || action === "adjust_adset_budget") {
    const entityId = String(args.entityId);
    const owner = await failClosed(() => meta.entityAccountId(entityId), "owner_unreadable", "entity owner");
    if (!owner.ok) return owner.decision;
    const ownerAcct = canonAccount(owner.value);
    const allowed = canonAccount(config.managedAccountId);
    if (ownerAcct === null) {
      return refuse("scope_unknown", "could not resolve entity's owning account (fail-closed)");
    }
    if (config.deniedAccountIds.map(canonAccount).includes(ownerAcct)) {
      return refuse("scope_denied", `entity belongs to a denied account (${ownerAcct})`);
    }
    if (ownerAcct !== allowed) {
      return refuse("scope_mismatch", `entity belongs to ${ownerAcct}, not the managed account`);
    }
  }

  // 7. Per-action logic.
  if (action === "pause") {
    // Pause only reduces spend — no budget/spend checks needed.
    return { allowed: true, effectiveArgs: { entityId: args.entityId, status: "PAUSED" } };
  }

  if (action === "adjust_adset_budget") {
    return evaluateBudget(args, deps);
  }

  if (action === "publish_approved_creative") {
    const hash = String(args.approvalHash);
    const appr = await failClosed(() => db.approvalByHash(hash), "approval_unreadable", "approval record");
    if (!appr.ok) return appr.decision;
    if (appr.value === null) {
      return refuse("approval_missing", "no immutable approval record matches this exact creative");
    }
    // only an exact consumed===false is OK; anything else (malformed) -> refuse
    if (appr.value.consumed !== false) {
      return refuse("approval_consumed", "approval is used or its state is unknown — refused (fail-closed)");
    }
    return { allowed: true, effectiveArgs: { approvalHash: hash } };
  }

  return refuse("unknown_action", `unknown action '${action}'`);
}

// --- strict per-action argument validation -------------------------------

function validateArgs(action: ActionType, args: Record<string, unknown>): Decision | null {
  if (typeof args !== "object" || args === null) {
    return refuse("args_invalid", "arguments must be a non-null object");
  }
  const keys = Object.keys(args);
  if (action === "pause") {
    const allowed = new Set(["entityId", "status"]);
    const extra = keys.filter((k) => !allowed.has(k));
    if (extra.length) return refuse("args_extra", `pause accepts only entityId+status; got extra: ${extra.join(",")}`);
    if (typeof args.entityId !== "string" || args.entityId === "") return refuse("args_entity", "entityId required");
    if (args.status !== "PAUSED") return refuse("args_status", `pause status must be exactly 'PAUSED', got '${String(args.status)}'`);
    return null;
  }
  if (action === "adjust_adset_budget") {
    const allowed = new Set(["entityId", "dailyBudget"]);
    const extra = keys.filter((k) => !allowed.has(k));
    if (extra.length) return refuse("args_extra", `budget accepts only entityId+dailyBudget; got extra: ${extra.join(",")}`);
    if (typeof args.entityId !== "string" || args.entityId === "") return refuse("args_entity", "entityId required");
    if (!isFinitePositive(args.dailyBudget) || !Number.isInteger(args.dailyBudget)) {
      return refuse("args_budget", "dailyBudget must be a finite positive integer");
    }
    return null;
  }
  if (action === "publish_approved_creative") {
    const allowed = new Set(["approvalHash"]);
    const extra = keys.filter((k) => !allowed.has(k));
    if (extra.length) return refuse("args_extra", `publish accepts only approvalHash; got extra: ${extra.join(",")}`);
    if (typeof args.approvalHash !== "string" || args.approvalHash === "") {
      return refuse("args_approval", "approvalHash required");
    }
    return null;
  }
  return refuse("unknown_action", `unknown action '${action}'`);
}

// --- budget clamp + caps ---------------------------------------------------

async function evaluateBudget(args: Record<string, unknown>, deps: GuardDeps): Promise<Decision> {
  const { config, db, meta, now } = deps;
  const entityId = String(args.entityId);
  const requested = args.dailyBudget as number;
  let day: string;
  try {
    day = dayString(now(), config.accountTimezone);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return refuse("tz_invalid", `account timezone unusable — refused (fail-closed): ${msg}`);
  }
  const bc = config.budgetClamp;

  // Budget locus: refuse CBO ad-set budget writes (budget lives on the campaign).
  const cb = await failClosed(() => meta.currentBudget(entityId), "budget_unreadable", "current budget");
  if (!cb.ok) return cb.decision;
  if (cb.value === null) return refuse("budget_unknown", "could not read current budget (fail-closed)");
  if (cb.value.ownedByCampaignCbo && bc.blockCboAdsetBudgetWrites) {
    return refuse("budget_cbo", "ad set budget is owned by the campaign (CBO) — refused");
  }
  // Meta sends lifetimeBudget=0 for normal daily-budget ad sets (don't block those).
  // A positive value = a real lifetime budget -> refuse. Negative/NaN -> refuse (malformed).
  const lb = cb.value.lifetimeBudget;
  if (lb != null) {
    if (typeof lb !== "number" || !Number.isFinite(lb) || lb < 0) {
      return refuse("budget_unknown", "malformed lifetimeBudget — refused (fail-closed)");
    }
    if (bc.blockLifetimeBudgetWrites && lb > 0) {
      return refuse("budget_lifetime", "ad set uses a lifetime budget — daily-budget writes refused in this phase");
    }
  }

  // Baseline = frozen start-of-day snapshot. No snapshot / non-finite = refuse.
  const sodRead = await failClosed(() => db.startOfDayBudget(entityId, day), "sod_unreadable", "start-of-day budget");
  if (!sodRead.ok) return sodRead.decision;
  const baseline = sodRead.value;
  if (!isFinitePositive(baseline)) {
    return refuse("baseline_missing", "no valid start-of-day budget baseline — refused (fail-closed)");
  }

  // Cap increases at +maxSingleChangePct vs the start-of-day budget. Decreases
  // pass through unchanged (less spend = safe). Floor to a whole number first
  // so the caps check the exact value we'd write.
  const maxUp = baseline * (1 + bc.maxSingleChangePct / 100);
  const clamped = Math.floor(Math.min(requested, maxUp));
  // Two distinct "increase" notions gate the ceilings below:
  // - isIncrease: above the FROZEN start-of-day baseline (per-entity clamp and
  //   cross-day creep semantics).
  // - raisesLive: above the entity's CURRENT live budget. A write at/below the
  //   baseline can still RAISE live spend capacity (lower-then-restore), so the
  //   account cap and spend caps must also run for those — otherwise N restores
  //   compound past the daily ceilings without ever counting as an "increase".
  const isIncrease = clamped > baseline;
  const entityCurrent = cb.value.dailyBudget;
  if (!isFinitePositive(entityCurrent)) {
    return refuse("budget_unknown", "entity's current daily budget unreadable — refused (fail-closed)");
  }
  const raisesLive = clamped > entityCurrent;

  // Stop a budget creeping up over many days (e.g. +25% nightly): refuse if it
  // passes a multiple of the 30-day normal. No 30d history yet -> skip.
  const b30Read = await failClosed(() => db.budgetBaseline30d(entityId, day), "b30_unreadable", "30-day budget baseline");
  if (!b30Read.ok) return b30Read.decision;
  const b30 = b30Read.value;
  if (isIncrease && isFinitePositive(b30) && clamped >= b30 * bc.crossDayMaxMultipleVs30dBaseline) {
    return refuse(
      "cross_day_creep",
      `budget ${clamped.toFixed(2)} exceeds ${bc.crossDayMaxMultipleVs30dBaseline}x the 30-day baseline (${b30})`
    );
  }

  // Account aggregate cap (only when live spend capacity goes UP — a true
  // decrease must never be blocked by account totals): the projected LIVE
  // account total may not reach +maxAccountChangePerDayPct over the frozen SoD
  // total. Using the live total (current entity budget swapped for the clamped
  // value) makes the cap CUMULATIVE: increases already applied earlier today —
  // by the agent on other ad sets, or by a human — consume the same day
  // headroom. A per-decision delta against the frozen total alone would let N
  // distinct ad-set raises compound to the per-entity bound instead.
  if (isIncrease || raisesLive) {
    const acctRead = await failClosed(() => db.accountStartOfDayTotal(day), "acct_sod_unreadable", "account SoD total");
    if (!acctRead.ok) return acctRead.decision;
    const acctSoD = acctRead.value;
    if (!isFinitePositive(acctSoD)) {
      return refuse("acct_baseline_missing", "no valid account start-of-day total — refused (fail-closed)");
    }
    const liveRead = await failClosed(() => meta.accountActiveDailyBudgetTotal(), "acct_live_unreadable", "live account budget total");
    if (!liveRead.ok) return liveRead.decision;
    const liveTotal = liveRead.value;
    if (!isFinitePositive(liveTotal)) {
      return refuse("acct_live_missing", "could not read the live account budget total — refused (fail-closed)");
    }
    const projectedAcctTotal = liveTotal - entityCurrent + clamped;
    if (projectedAcctTotal >= acctSoD * (1 + bc.maxAccountChangePerDayPct / 100)) {
      return refuse(
        "account_cap",
        `change would push the live account budget to ${projectedAcctTotal.toFixed(2)}, over +${bc.maxAccountChangePerDayPct}% of the start-of-day total (${acctSoD})`
      );
    }
  }

  // Spend cap (whenever live spend capacity goes up): enforce on REAL realised spend.
  if (isIncrease || raisesLive) {
    const spendRead = await failClosed(() => meta.realisedSpend(), "spend_unreadable", "realised spend");
    if (!spendRead.ok) return spendRead.decision;
    const spend = spendRead.value;
    if (spend === null || spend.complete !== true) {
      return refuse("spend_indeterminate", "realised spend unavailable or incomplete — refused (treat empty as unknown)");
    }
    if (spend.dateStop !== day) {
      return refuse("spend_stale", `spend snapshot covers ${spend.dateStop}, not today ${day} — refused`);
    }
    const sc = config.spendCaps;
    if (spend.today >= sc.dailyAud * sc.sameDayDecisionFractionOfDailyCap) {
      return refuse("daily_spend_cap", `today's spend A$${spend.today} is at/over the same-day decision limit`);
    }
    if (spend.monthToDate + sc.monthEndRevisionBufferAud >= sc.monthlyAud) {
      return refuse("monthly_spend_cap", `month-to-date spend A$${spend.monthToDate} (+buffer) is at/over the monthly cap`);
    }
  }

  return { allowed: true, effectiveArgs: { entityId, dailyBudget: clamped } };
}
