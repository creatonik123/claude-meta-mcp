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
