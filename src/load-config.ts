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

const ConfigSchema = z
  .object({
    managedAccountId: z.string().min(1),
    deniedAccountIds: z.array(z.string()),
    currency: z.string().optional(),
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
        spendSnapshotMaxAgeMinutes: z.number().positive(),
        monthEndRevisionBufferAud: z.number().nonnegative(),
      })
      .strict(),
    targets: z.object({ targetCplAud: z.number().positive(), provisional: z.boolean() }).strict(),
    schemaVersion: z.number().int(),
  })
  .strict();

const FORBIDDEN_ACCOUNT = "act_2218833115522041";

/** Read + validate guard.config.json (next to the package root). */
export function loadGuardConfig(url = new URL("../guard.config.json", import.meta.url)): GuardConfig {
  const raw = JSON.parse(readFileSync(url, "utf8"));
  return ConfigSchema.parse(raw) as GuardConfig;
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
