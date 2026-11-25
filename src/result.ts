import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Cap on one tool result, so a large listing cannot swallow the agent's context. */
export const MAX_RESULT_CHARS = 50_000;

/** A failure worth showing the agent verbatim: bad input, unknown names. */
export class UserError extends Error {}

/**
 * What was left out when an answer was cut to MAX_RESULT_CHARS. It travels
 * as its own JSON text block after the data, and in `_meta`
 * ("maviapi/truncation"), so an agent or a client can tell a cut answer from
 * a short one without parsing a sentence.
 */
export interface Truncation {
  truncated: true;
  /** Rows in this tool answer. */
  rows_returned?: number;
  /** Rows the API sent. */
  rows_in_answer?: number;
  /** The `limit` the call asked for, when it passed one. */
  rows_asked?: number;
  max_chars: number;
  note: string;
}

const META_KEY = "maviapi/truncation";

type Json = unknown;

/** The path to the longest list in a JSON answer, two levels deep at most: where its rows are. */
function rowsPath(value: Json, depth = 0): Array<string | number> | null {
  if (Array.isArray(value)) return [];
  if (!value || typeof value !== "object" || depth > 1) return null;
  let best: { path: Array<string | number>; size: number } | null = null;
  for (const [key, child] of Object.entries(value as Record<string, Json>)) {
    const sub = rowsPath(child, depth + 1);
    if (!sub) continue;
    const size = JSON.stringify(child).length;
    if (!best || size > best.size) best = { path: [key, ...sub], size };
  }
  return best?.path ?? null;
}

function getAt(value: Json, path: Array<string | number>): Json {
  return path.reduce<Json>((node, key) => (node as Record<string | number, Json>)[key], value);
}

/** A copy of `value` whose list at `path` keeps only its first `n` rows. */
function withRows(value: Json, path: Array<string | number>, n: number): Json {
  if (!path.length) return (value as Json[]).slice(0, n);
  const [key, ...rest] = path;
  return { ...(value as Record<string, Json>), [key as string]: withRows((value as Record<string, Json>)[key as string], rest, n) };
}

/**
 * An endpoint's answer as tool text, cut to `max` characters when it is
 * longer. A JSON answer is cut at whole rows of its longest list, so what is
 * left still parses; anything else is cut at `max` characters. The result
 * says what was left out, and that the HTTP API itself never cuts.
 */
export function fitAnswer(
  body: unknown,
  opts: { asked?: number; url?: string; max?: number } = {},
): CallToolResult {
  const max = opts.max ?? MAX_RESULT_CHARS;
  const full = typeof body === "string" ? body : JSON.stringify(body);
  if (full.length <= max) return text(full);

  const where = opts.url ? ` (${opts.url})` : "";
  const http = `The HTTP API${where} does not cut answers.`;
  let kept: string | null = null;
  let truncation: Truncation | null = null;
  const path = typeof body === "string" ? null : rowsPath(body);
  if (path) {
    const rows = getAt(body, path) as Json[];
    // The most rows that still fit: whole rows only, so the JSON stays valid.
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (JSON.stringify(withRows(body, path, mid)).length <= max) lo = mid;
      else hi = mid - 1;
    }
    const candidate = JSON.stringify(withRows(body, path, lo));
    if (lo > 0 && candidate.length <= max) {
      kept = candidate;
      truncation = {
        truncated: true,
        rows_returned: lo,
        rows_in_answer: rows.length,
        ...(opts.asked !== undefined && { rows_asked: opts.asked }),
        max_chars: max,
        note:
          `This tool cut the answer to ${lo} of its ${rows.length} rows to stay under ${max.toLocaleString("en-US")} characters. ` +
          `${http} Pass a smaller limit and page with offset to read the rest here.`,
      };
    }
  }
  if (!truncation) {
    kept = full.slice(0, max);
    truncation = {
      truncated: true,
      ...(opts.asked !== undefined && { rows_asked: opts.asked }),
      max_chars: max,
      note:
        `This tool cut the answer at ${max.toLocaleString("en-US")} of its ${full.length.toLocaleString("en-US")} characters, so the text above is incomplete. ` +
        `${http} Pass a smaller limit and page with offset to read the rest here.`,
    };
  }
  return {
    content: [
      { type: "text", text: kept ?? "" },
      { type: "text", text: JSON.stringify(truncation) },
    ],
    _meta: { [META_KEY]: truncation },
  };
}

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
