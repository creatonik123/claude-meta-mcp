/**
 * Startup self-check (GUARD_DESIGN.md v3 §3): refuse to boot if any registered
 * tool is a write tool that is not one of the guarded write tools. This is the
 * backstop for the read-only registration gate — it fires if the gate ever
 * lets a write through, OR if a write name is mistakenly added to the read
 * allow-list, because it detects writes INDEPENDENTLY of that allow-list
 * (by known-write set, write-verb prefix, or simply not being an allowed read).
 * Pure + testable; nothing here touches Meta.
 */
import {
  isAllowedReadTool,
  GATED_WRITE_TOOLS,
  KNOWN_WRITE_TOOLS,
  WRITE_VERB_PATTERN,
} from "./tool-gate.js";

// Layered defense-in-depth: `!isAllowedReadTool` (default-deny by exact name)
// is the primary catch; the known-write set and write-verb pattern are the
// belt-and-suspenders that still fire if a write name were ever mistakenly
// added to the read allow-list (so the backstop does not share the gate's
// single source of truth). Exported for direct branch testing.
export function isForbiddenInRegisteredSet(name: string): boolean {
  if (GATED_WRITE_TOOLS.has(name)) return false; // the only permitted writes
  return KNOWN_WRITE_TOOLS.has(name) || WRITE_VERB_PATTERN.test(name) || !isAllowedReadTool(name);
}

export function assertSafeToolRegistration(registered: Iterable<string>): void {
  const offenders: string[] = [];
  for (const name of registered) {
    if (isForbiddenInRegisteredSet(name)) offenders.push(name);
  }
  if (offenders.length > 0) {
    throw new Error(
      `AdPilot startup refused: ${offenders.length} forbidden tool(s) registered (write/unlisted): ${offenders.join(", ")}`
    );
  }
}
