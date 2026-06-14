/**
 * Installs the read-only registration gate on an MCP server: wraps registerTool
 * so only READ_ALLOWLIST names actually register. Returns both the names that
 * were ATTEMPTED and those that survived (registered), so the boot path can run
 * the independent startup backstop over the registered set. Extracted from
 * index.ts so the wiring is unit-testable. Nothing here touches Meta.
 */
import { isAllowedReadTool } from "./tool-gate.js";

// Minimal shape we depend on — the real McpServer satisfies this.
export interface ToolRegistrar {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool: (name: string, ...rest: any[]) => any;
}

export function installReadOnlyGate(
  mcp: ToolRegistrar,
  onRefused?: (name: string) => void
): { attempted: string[]; registered: string[] } {
  const attempted: string[] = [];
  const registered: string[] = [];
  const raw = mcp.registerTool.bind(mcp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcp.registerTool = (name: string, ...rest: any[]) => {
    attempted.push(name);
    if (!isAllowedReadTool(name)) {
      onRefused?.(name);
      return undefined;
    }
    registered.push(name);
    return raw(name, ...rest);
  };
  return { attempted, registered };
}
