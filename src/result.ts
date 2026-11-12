import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Cap on one tool result, so a large listing cannot swallow the agent's context. */
export const MAX_RESULT_CHARS = 50_000;

/** A failure worth showing the agent verbatim: bad input, unknown names. */
export class UserError extends Error {}

export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

export function failure(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

export function stringArg(args: Record<string, unknown>, name: string, required: true): string;
export function stringArg(args: Record<string, unknown>, name: string, required?: false): string | undefined;
export function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === undefined || value === null || value === "") {
    if (required) throw new UserError(`\`${name}\` is required.`);
    return undefined;
  }
  throw new UserError(`\`${name}\` must be a string.`);
}

/** Models sometimes send `params` as a JSON string; accept that too. */
export function objectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  let value = args[name];
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new UserError(`\`${name}\` must be an object, e.g. {"q": "istanbul"}.`);
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(`\`${name}\` must be an object, e.g. {"q": "istanbul"}.`);
  }
  return value as Record<string, unknown>;
}

/** "45 seconds", "30 minutes", "29 days": the largest unit that fits. */
export function humanDuration(seconds: number): string {
  const units: Array<[string, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of units) {
    if (seconds >= size) {
      const n = Math.round(seconds / size);
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
