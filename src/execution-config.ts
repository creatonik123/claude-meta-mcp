/**
 * The doer's master execution switch. Default OFF: execution is enabled only by an
 * explicit opt-in env flag, and any other value fails safe to off. This is a second
 * gate on top of the guard's per-action modes — both must permit a write.
 */
export const EXECUTION_ENV_FLAG = "ADPILOT_EXECUTION_ENABLED";

export function resolveExecutionEnabled(env: Record<string, string | undefined>): boolean {
  const v = env[EXECUTION_ENV_FLAG];
  return v === "true" || v === "1";
}

// Boot guard: if execution is enabled, refuse to start unless every dependency the
// doer needs is present and valid. Better to fail loud at boot than to run the live
// server half-wired with writes turned on. A no-op when execution is off.
export function assertExecutionBootSafe(
  env: Record<string, string | undefined>,
  deps: { writer?: unknown; reader?: unknown; coordinator?: unknown; currencyOffset?: unknown }
): void {
  if (!resolveExecutionEnabled(env)) return; // recommend-only — nothing to wire
  for (const name of ["writer", "reader", "coordinator"] as const) {
    if (deps[name] == null || typeof deps[name] !== "object") {
      throw new Error(`execution enabled but ${name} is not wired — refusing to boot`);
    }
  }
  const off = deps.currencyOffset;
  if (typeof off !== "number" || !Number.isInteger(off) || off <= 0) {
    throw new Error(`execution enabled but currencyOffset '${String(off)}' is invalid — refusing to boot`);
  }
}
