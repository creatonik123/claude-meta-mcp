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

const FORBIDDEN_ACCOUNT = "act_2218833115522041";

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
  const notOff = Object.entries(config.actionModes)
    .filter(([, m]) => m !== "off")
    .map(([k]) => k);
  if (notOff.length > 0) {
    throw new Error(
      `ship invariant violated: action modes must all be 'off' (recommend-only); not off: ${notOff.join(", ")}`
    );
  }
  if (!config.deniedAccountIds.includes(FORBIDDEN_ACCOUNT)) {
    throw new Error(`ship invariant violated: ${FORBIDDEN_ACCOUNT} missing from deniedAccountIds`);
  }
}
