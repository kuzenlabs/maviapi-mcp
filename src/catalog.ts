/**
 * Pure helpers over the public maviapi catalog: normalizing endpoint schema
 * docs into tool input schemas, resolving names, building request paths, and
 * rendering compact summaries for an agent to read. No network here.
 */

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
};

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

/** One catalog API, as returned by GET /v1/apis. */
export interface ApiSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  target_url: string | null;
}

/** One endpoint's schema doc (an entry of `versions` under ?include=schemas). */
export interface SchemaDoc {
  version: string;
  title?: string | null;
  description?: string | null;
  input_schema?: JsonSchema | null;
  output_schema?: JsonSchema | null;
}

/** One endpoint, as returned by GET /v1/apis/:slug/endpoints?include=schemas. */
export interface RawEndpoint {
  slug: string;
  path: string;
  method: string;
  description: string | null;
  versions?: SchemaDoc[];
}

export interface Endpoint {
  /** Stable, tool-safe name derived from the catalog slug (see endpointName). */
  name: string;
  slug: string;
  path: string;
  method: string;
  description: string;
  pathParams: string[];
  inputSchema: ToolInputSchema;
  outputSchema: JsonSchema | null;
}

/**
 * Parameters kept out of the schemas an agent sees. `refresh` bypasses the
 * endpoint cache and forces a fresh fetch of the source site: useful for a
 * human debugging a stale result, wasteful when an agent sets it by reflex.
 */
const HIDDEN_PARAMS = new Set(["refresh"]);

/** Results per page when an agent omits `limit`: endpoints default to 50, which floods a context window. */
export const DEFAULT_LIMIT = 10;

/** Path parameter names, in order. Accepts both `/items/{id}` and `/items/:id`. */
export function pathParams(path: string): string[] {
  return path
    .split("/")
    .map(paramName)
    .filter((name): name is string => name !== null);
}

function paramName(segment: string): string | null {
  if (segment.startsWith(":") && segment.length > 1) return segment.slice(1);
  if (segment.startsWith("{") && segment.endsWith("}") && segment.length > 2) {
    return segment.slice(1, -1);
  }
  return null;
}

/**
 * A readable endpoint name. Catalog slugs are inconsistent: some are a bare
 * word ("hotel" for /hotel/{country}/{slug}), others the route itself
 * ("listing/:id"). Static segments are kept and parameters become a `_by_`
 * suffix, so /templates and /templates/:id stay distinct.
 */
export function endpointName(slug: string): string {
  const parts = slug.split("/").filter(Boolean);
  const words = parts.filter((p) => paramName(p) === null);
  const params = parts.map(paramName).filter((p): p is string => p !== null);
  const base = words.join("-") || "root";
  return params.length ? `${base}_by_${params.join("_and_")}` : base;
}

export class MissingParamsError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  }
}

/**
 * Substitute path parameters into an endpoint path. Returns the concrete path
 * and the parameters left over, which go in the query string.
 */
export function fillPath(
  path: string,
  params: Record<string, unknown>,
): { path: string; query: Record<string, unknown> } {
  const query = { ...params };
  const missing: string[] = [];
  const segments = path.split("/").map((segment) => {
    const name = paramName(segment);
    if (name === null) return segment;
    const value = query[name];
    delete query[name];
    if (value === undefined || value === null || value === "") {
      missing.push(name);
      return segment;
    }
    return encodeURIComponent(String(value));
  });
  if (missing.length) throw new MissingParamsError(missing);
  return { path: segments.join("/"), query };
}

/** Encode query parameters. Arrays become comma lists, objects JSON. */
export function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) search.set(key, value.map(String).join(","));
    else if (typeof value === "object") search.set(key, JSON.stringify(value));
    else search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The newest schema doc of an endpoint, if it has any. */
export function pickSchemaDoc(docs: SchemaDoc[] | undefined): SchemaDoc | undefined {
  if (!docs?.length) return undefined;
  return [...docs].sort((a, b) => compareVersions(b.version, a.version))[0];
}

/**
 * Reduce a property schema to the keywords tool clients understand. The
 * catalog uses OpenAPI's singular `example`, which is not JSON Schema; it is
 * folded into the description where a model will actually read it.
 */
export function cleanSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  if (schema.type !== undefined) out.type = schema.type;
  const parts = [schema.description?.trim() ?? ""];
  if (schema.example !== undefined && schema.example !== schema.default) {
    parts.push(`Example: ${JSON.stringify(schema.example)}`);
  }
  const description = sentences(parts);
  if (description) out.description = description;
  for (const key of ["enum", "default", "format", "minimum", "maximum"]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.items) out.items = cleanSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, cleanSchema(v)]),
    );
    if (schema.required?.length) out.required = [...schema.required];
  }
  return out;
}

/** Join fragments as sentences: one period between them, never two. */
export function sentences(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p, i, all) => (i < all.length - 1 && !/[.!?…]$/.test(p) ? `${p}.` : p))
    .join(" ");
}

export function normalizeEndpoint(raw: RawEndpoint): Endpoint {
  const doc = pickSchemaDoc(raw.versions);
  const input = doc?.input_schema ?? {};
  const params = pathParams(raw.path);

  const properties: Record<string, JsonSchema> = {};
  for (const [name, prop] of Object.entries(input.properties ?? {})) {
    if (!HIDDEN_PARAMS.has(name)) properties[name] = cleanSchema(prop);
  }
  // A path parameter is always required, whether or not the doc says so.
  for (const name of params) properties[name] ??= { type: "string" };
  const required = [
    ...new Set([...params, ...(input.required ?? []).filter((name) => name in properties)]),
  ];

  const inputSchema: ToolInputSchema = { type: "object", properties };
  if (required.length) inputSchema.required = required;

  return {
    name: endpointName(raw.slug),
    slug: raw.slug,
    path: raw.path,
    method: raw.method.toUpperCase(),
    description: (raw.description || doc?.description || doc?.title || "").trim(),
    pathParams: params,
    inputSchema,
    outputSchema: doc?.output_schema ?? null,
  };
}

/** Bare host of a URL or domain, without `www.`; null when it is not one. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.includes(".")) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Resolve an API by slug, name, or the domain / URL of its site. */
export function findApi(apis: ApiSummary[], ref: string): ApiSummary | undefined {
  const r = ref.trim().toLowerCase();
  const host = hostOf(r);
  return (
    apis.find((a) => a.slug.toLowerCase() === r) ??
    apis.find((a) => a.name.toLowerCase() === r) ??
    (host ? apis.find((a) => hostOf(a.target_url) === host) : undefined)
  );
}

/** Resolve an endpoint by name, catalog slug, or path (leading slash optional). */
export function findEndpoint(endpoints: Endpoint[], ref: string): Endpoint | undefined {
  const r = ref.trim().toLowerCase().replace(/^\/+/, "");
  return (
    endpoints.find((e) => e.name.toLowerCase() === r) ??
    endpoints.find((e) => e.slug.toLowerCase() === r) ??
    endpoints.find((e) => e.path.toLowerCase().replace(/^\/+/, "") === r)
  );
}

/** Query words that say nothing about which API is meant. */
const STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "for", "to", "from", "by", "with", "and", "or", "near",
  "api", "apis", "data", "site", "website", "com", "www",
]);

/**
 * A score an API reaches only through its slug, name or site (not its
 * description alone). With it an API is kept even when some query words miss.
 */
export const STRONG_MATCH = 4;

/** Lowercase words of a text: letters and digits in any script, split at everything else. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(singular);
}

/** The query words that count: stopwords and one-letter words dropped (unless nothing else is left). */
function queryTokens(q: string): string[] {
  const all = words(q).filter((t) => t.length > 1);
  const meaningful = all.filter((t) => !STOP_WORDS.has(t));
  return meaningful.length ? meaningful : all;
}

/** How strongly one query word matches an API: 0 when it does not. */
function tokenHit(api: ApiSummary, token: string): number {
  const slug = api.slug.toLowerCase();
  const host = hostOf(api.target_url) ?? "";
  let hit = 0;
  if (slug === token) hit += 10;
  else if (words(slug).includes(token) || (token.length >= 4 && slug.includes(token))) hit += 5;
  if (words(host).includes(token) || (token.length >= 4 && host.includes(token))) hit += 5;
  if (words(api.name).includes(token)) hit += 4;
  if (words(api.description ?? "").includes(token)) hit += 1;
  return hit;
}

/**
 * Rank catalog APIs against a free-text query. An empty query lists them all.
 *
 * Query words match whole words (not parts of words, so "out" does not match
 * "without"), and an API is kept only when every query word matches it
 * somewhere, or one matches its slug, name or site. A query no API answers
 * returns nothing, rather than every API that shares a word with it; see
 * partialMatches for the closest APIs then.
 * `loose` keeps any API that matches one word: for "did you mean" hints.
 */
export function searchApis(apis: ApiSummary[], query: string | undefined, opts: { loose?: boolean } = {}): ApiSummary[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return [...apis];
  const queryHost = hostOf(q);
  const tokens = queryTokens(q);

  const scored = apis.map((api) => {
    const host = hostOf(api.target_url) ?? "";
    let score = queryHost && queryHost === host ? 20 : 0;
    let matched = 0;
    for (const token of tokens) {
      const hit = tokenHit(api, token);
      if (hit) matched++;
      score += hit;
    }
    const kept = opts.loose || score >= STRONG_MATCH || (tokens.length > 0 && matched === tokens.length);
    return { api, score: kept ? score : 0, matched };
  });

  // An API that matches more of the query's words ranks first, then the higher score.
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.matched - a.matched || b.score - a.score)
    .map((s) => s.api);
}

/** An API that answers some, not all, of a query's words. */
export interface PartialMatch {
  api: ApiSummary;
  matched: string[];
  missed: string[];
}

/** Most partial matches an answer lists. */
export const MAX_PARTIAL = 5;

/**
 * The APIs that match at least one query word (after stopwords) as a whole
 * word in name, slug, site or description, best first, at most MAX_PARTIAL.
 * For when no API matches every word: "events istanbul" has no API about both,
 * but event APIs exist and take the city as a parameter.
 */
export function partialMatches(apis: ApiSummary[], query: string | undefined): { words: string[]; hits: PartialMatch[] } {
  const tokens = queryTokens((query ?? "").trim().toLowerCase());
  const hits = apis
    .map((api) => {
      const scores = tokens.map((token) => tokenHit(api, token));
      return {
        api,
        score: scores.reduce((a, b) => a + b, 0),
        matched: tokens.filter((_, i) => scores[i]),
        missed: tokens.filter((_, i) => !scores[i]),
      };
    })
    .filter((s) => s.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length || b.score - a.score)
    .slice(0, MAX_PARTIAL)
    .map(({ api, matched, missed }) => ({ api, matched, missed }));
  return { words: tokens, hits };
}

/** "hotels" -> "hotel", so a plural query still matches a singular description. Leaves "news" and "class" alone. */
function singular(token: string): string {
  return token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

function typeLabel(schema: JsonSchema): string {
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : (schema.type ?? "any");
  if (type === "array" && schema.items) return `${typeLabel(schema.items)}[]`;
  return type;
}

/** One line per input parameter, required ones first. */
export function describeParams(schema: ToolInputSchema): string[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties)
    .sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)))
    .map(([name, prop]) => {
      const bits = [typeLabel(prop)];
      if (required.has(name)) bits.push("required");
      const notes = sentences([
        prop.description ?? "",
        prop.enum ? `One of: ${prop.enum.map((v) => JSON.stringify(v)).join(", ")}` : "",
        prop.default !== undefined ? `Default: ${JSON.stringify(prop.default)}` : "",
      ]);
      return `- ${name} (${bits.join(", ")})${notes ? `: ${notes}` : ""}`;
    });
}

/**
 * Flatten a response schema into `path: type` lines (`data.items[].price:
 * number`), so an agent knows which fields come back without reading a full
 * JSON Schema document. Past `maxLines`, one last line says how many fields
 * were left out.
 */
export function outlineOutput(schema: JsonSchema | null, maxLines = OUTLINE_MAX_LINES, maxDepth = 5): string[] {
  if (!schema) return [];
  const lines: string[] = [];
  const walk = (node: JsonSchema, prefix: string, depth: number) => {
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (lines.length > OUTLINE_HARD_CAP) return;
      const path = prefix ? `${prefix}.${key}` : key;
      if (child.properties && depth < maxDepth) {
        walk(child, path, depth + 1);
      } else if (child.items?.properties && depth < maxDepth) {
        walk(child.items, `${path}[]`, depth + 1);
      } else {
        lines.push(`${path}: ${typeLabel(child)}`);
      }
    }
  };
  walk(schema, "", 0);
  if (lines.length <= maxLines) return lines;
  const left = lines.length - maxLines;
  const more = lines.length > OUTLINE_HARD_CAP ? `${left}+` : String(left);
  return [...lines.slice(0, maxLines), `… and ${more} more field${left === 1 ? "" : "s"}`];
}

/**
 * Response fields get_api lists per endpoint. Endpoints return a few dozen
 * fields; a full list keeps an agent from guessing at the ones it cannot see.
 */
export const OUTLINE_MAX_LINES = 200;
/** Stop walking a schema past this many fields. */
const OUTLINE_HARD_CAP = 1000;

/** MCP tool names allow [A-Za-z0-9_-], up to 64 characters. */
export function toolName(apiSlug: string, endpointSlug: string): string {
  return `${apiSlug}_${endpointSlug}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** Cut text to `max` characters. A `note` says why and what to do about it; without one, an ellipsis ends the cut. */
export function truncate(text: string, max: number, note?: string): string {
  if (text.length <= max) return text;
  return note ? `${text.slice(0, max)}\n…[truncated: ${note}]` : `${text.slice(0, max - 1)}…`;
}
