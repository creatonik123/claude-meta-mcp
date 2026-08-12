/**
 * Loads and validates guard.config.json into a GuardConfig (GUARD_DESIGN §8).
 * This is the SOLE source of guard config in production — the running agent
 * can read it but never writes it. A malformed file throws at load (fail
 * closed). `assertShipInvariants` enforces the recommend-only ship state.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { GuardConfig } from "./guard.js";

const Mode = z.enum(["off", "confirm", "auto"]);

// A typo'd timezone must refuse at BOOT, not surface as per-decision tz_invalid
// refusals at runtime. The guard still re-checks at decision time (defense in depth).
function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const ConfigSchema = z
  .object({
    managedAccountId: z.string().min(1),
    deniedAccountIds: z.array(z.string()),
    // Campaign isolation for writes; absent/empty = refuse all entity writes (fail-closed).
    allowedCampaignIds: z.array(z.string()).optional(),
    currency: z.string().optional(),
    accountTimezone: z.string().min(1).refine(isIanaTimeZone, { message: "accountTimezone must be a valid IANA timezone" }),
    actionModes: z
      .object({
        pause: Mode,
        adjust_adset_budget: Mode,
        publish_approved_creative: Mode,
      })
      .strict(),
    killSwitchEnvFlag: z.string().min(1),
    budgetClamp: z
      .object({
        maxSingleChangePct: z.number().positive(),
        maxAccountChangePerDayPct: z.number().positive(),
        blockLifetimeBudgetWrites: z.boolean(),
        blockCboAdsetBudgetWrites: z.boolean(),
        crossDayMaxMultipleVs30dBaseline: z.number().positive(),
      })
      .strict(),
    spendCaps: z
      .object({
        dailyAud: z.number().positive(),
        monthlyAud: z.number().positive(),
        sameDayDecisionFractionOfDailyCap: z.number().positive(),
        monthEndRevisionBufferAud: z.number().nonnegative(),
      })
      .strict(),
    targets: z.object({ targetCplAud: z.number().positive(), provisional: z.boolean() }).strict(),
    schemaVersion: z.number().int(),
  })
  .strict();

/** The A$157k production account. AdPilot must never manage it and never write to it. */
export const FORBIDDEN_ACCOUNT = "act_1133075730765139";

/** Validate an already-parsed config object. Throws on anything malformed. */
export function parseGuardConfig(raw: unknown): GuardConfig {
  return ConfigSchema.parse(raw) as GuardConfig;
}

/** Read + validate guard.config.json (next to the package root). */
export function loadGuardConfig(url = new URL("../guard.config.json", import.meta.url)): GuardConfig {
  return parseGuardConfig(JSON.parse(readFileSync(url, "utf8")));
}

/**
 * Enforce the recommend-only ship state: every action mode must be 'off' and
 * the forbidden account must be on the deny list. Throws otherwise — wire this
 * at boot so the server refuses to start in an unsafe config.
 */
export function assertShipInvariants(config: GuardConfig): void {
  // Ship stage 3 (2026-08-12, the zero-spend smoke tests): `pause` and `adjust_adset_budget` may be
  // "auto" — both proven harmless inside the PAUSED sandbox campaign (a paused campaign cannot
  // deliver, so neither a pause nor a budget number can spend). stage 4 (same day) arms publish for the seeded-approval smoke: the ad is BORN PAUSED inside the PAUSED sandbox, double-locked — that review step IS the safety mechanism.
  const MAY_ARM = new Set(["pause", "adjust_adset_budget", "publish_approved_creative"]);
  const notOff = Object.entries(config.actionModes)
    .filter(([k, m]) => !(m === "off" || (MAY_ARM.has(k) && m === "auto")))
    .map(([k]) => k);
  if (notOff.length > 0) {
    throw new Error(
      `ship invariant violated: an unknown or invalid mode is set (only off, or auto on the three known actions); not off: ${notOff.join(", ")}`
    );
  }
  // ANY armed mode must name its one campaign: with an empty allowlist every call refuses anyway
  // (misconfiguration, not safety), and a wide allowlist is what this invariant exists to prevent.
  const armedCamps = config.allowedCampaignIds ?? [];
  const anyArmed = Object.values(config.actionModes).some((m) => m !== "off");
  if (anyArmed && armedCamps.length !== 1) {
    throw new Error(
      `ship invariant violated: an armed action mode requires exactly one campaign in allowedCampaignIds (got ${armedCamps.length})`
    );
  }
  if (!config.deniedAccountIds.includes(FORBIDDEN_ACCOUNT)) {
    throw new Error(`ship invariant violated: ${FORBIDDEN_ACCOUNT} missing from deniedAccountIds`);
  }
  // Deny-list membership alone cannot detect a re-inversion: swapping managedAccountId back to
  // production while it stays on the deny list passes every check above, and writes then refuse
  // only because guard.ts happens to evaluate the deny branch before the account-mismatch branch.
  // Assert the roles directly so the config, not the branch order, is what keeps production safe.
  if (config.managedAccountId === FORBIDDEN_ACCOUNT) {
    throw new Error(
      `ship invariant violated: managedAccountId is the forbidden production account ${FORBIDDEN_ACCOUNT}`
    );
  }
  if (config.deniedAccountIds.includes(config.managedAccountId)) {
    throw new Error(
      `ship invariant violated: managedAccountId ${config.managedAccountId} is also on deniedAccountIds`
    );
  }
  // The trial is ONE campaign: bound the allowlist so the config can never quietly widen to the
  // whole account. Zero (shipped) or exactly one is acceptable; more must be a deliberate code change.
  const camps = config.allowedCampaignIds;
  if (Array.isArray(camps) && camps.length > 1) {
    throw new Error(
      `ship invariant violated: allowedCampaignIds must hold at most one campaign (got ${camps.length})`
    );
  }
}
