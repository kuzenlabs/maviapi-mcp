import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_LIMIT,
  MissingParamsError,
  describeParams,
  findApi,
  findEndpoint,
  hostOf,
  outlineOutput,
  searchApis,
  toolName,
  truncate,
  type ApiSummary,
  type Endpoint,
} from "./catalog.js";
import { MaviapiError, type CallResult, type MaviapiClient } from "./client.js";
import {
  PLAYGROUND_DAILY_LIMIT,
  PLAYGROUND_FREE_BUILDS,
  PLAYGROUND_RATE_LIMIT,
  siteLink,
  type Config,
} from "./config.js";

/** Cap on one tool result, so a large listing cannot swallow the agent's context. */
const MAX_RESULT_CHARS = 50_000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

const GENERIC_TOOLS: Tool[] = [
  {
    name: "search_apis",
    title: "Search maviapi APIs",
    description:
      "Find a ready-made maviapi API for a website or topic, e.g. \"hotels\", \"flights\", \"booking.com\" or \"turkish news\". " +
      "maviapi turns websites that have no official API into structured JSON endpoints, and monitors and repairs them when the site changes. " +
      "Leave `query` empty to list every API. Next step: get_api, to see an API's endpoints and parameters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Website, domain, or topic to look for. Empty lists everything." },
      },
    },
    annotations: { ...READ_ONLY, openWorldHint: false },
  },
  {
    name: "get_api",
    title: "Show a maviapi API",
    description:
      "Show one maviapi API's endpoints: what each returns, its parameters (required ones marked), and the fields in the response. " +
      "Accepts the API slug from search_apis, or the site's domain (e.g. \"airbnb.com\"). Read this before call_api.",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: "API slug (e.g. \"booking\") or the site's domain." },
      },
      required: ["api"],
    },
    annotations: { ...READ_ONLY, openWorldHint: false },
  },
  {
    name: "call_api",
    title: "Call a maviapi endpoint",
    description:
      "Fetch live, structured JSON from a website through a maviapi endpoint. " +
      "`api` is the API slug (or domain), `endpoint` the endpoint name or path from get_api, and `params` its parameters, path parameters such as {id} included. " +
      `List endpoints return ${DEFAULT_LIMIT} results unless you pass \`limit\`; page with \`offset\`. Each successful call uses one maviapi credit.`,
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: "API slug (e.g. \"booking\") or the site's domain." },
        endpoint: { type: "string", description: "Endpoint name (e.g. \"search\") or path (e.g. \"/search\")." },
        params: {
          type: "object",
          description: "Endpoint parameters, as listed by get_api.",
          additionalProperties: true,
        },
      },
      required: ["api", "endpoint"],
    },
    annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "create_api",
    title: "Build a new maviapi API",
    description:
      "Get an API built for a website that no catalog API covers. maviapi's build agent studies the site and deploys a hosted, " +
      "self-repairing JSON API from a plain-language description of the data you want. A build takes about half an hour: this " +
      "returns a request_id at once, then follow it with get_build_status. " +
      `With the shared demo key each network gets ${PLAYGROUND_FREE_BUILDS} free builds per 30 days.`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The website, e.g. \"https://news.ycombinator.com\"." },
        description: {
          type: "string",
          description:
            "The data wanted from the site, as specific as you can: pages, fields, filters. " +
            "E.g. \"front-page stories with title, url, points, comment count and author\".",
        },
        build_anyway: {
          type: "boolean",
          description: "Build even though the catalog already has an API for this site (it lacks what you need).",
        },
      },
      required: ["url", "description"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "get_build_status",
    title: "Check a maviapi build",
    description:
      "Progress of a build started with create_api: queued, building, deploying, published, or failed. " +
      "Once published it names the new API's slug, ready for get_api and call_api. Builds take about half an hour, " +
      "so check back every few minutes rather than in a tight loop.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request_id create_api returned." },
      },
      required: ["request_id"],
    },
    annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: false },
  },
];

/** A build as POST/GET /v1/requests return it. */
interface BuildPayload {
  id?: string;
  status?: string;
  domain?: string;
  slug?: string | null;
  error?: string | null;
  message?: string;
  progress?: Array<{ state: string; message: string; at: string }>;
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

/** A failure worth showing the agent verbatim: bad input, unknown names. */
class UserError extends Error {}

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function failure(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string, required: true): string;
function stringArg(args: Record<string, unknown>, name: string, required?: false): string | undefined;
function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === undefined || value === null || value === "") {
    if (required) throw new UserError(`\`${name}\` is required.`);
    return undefined;
  }
  throw new UserError(`\`${name}\` must be a string.`);
}

/** Models sometimes send `params` as a JSON string; accept that too. */
function objectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
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

interface DedicatedTool {
  tool: Tool;
  slug: string;
  endpoint: Endpoint;
}

export class Toolset {
  private dedicated: Promise<Map<string, DedicatedTool>> | null = null;
  private nudged = false;

  constructor(
    private readonly client: MaviapiClient,
    private readonly config: Config = client.config,
    private readonly log: (message: string) => void = (m) => console.error(m),
  ) {}

  async list(): Promise<Tool[]> {
    const dedicated = await this.dedicatedTools();
    return [...GENERIC_TOOLS, ...[...dedicated.values()].map((d) => d.tool)];
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    try {
      switch (name) {
        case "search_apis":
          return await this.searchApis(args);
        case "get_api":
          return await this.getApi(args);
        case "call_api":
          return await this.callApi(args);
        case "create_api":
          return await this.createApi(args);
        case "get_build_status":
          return await this.getBuildStatus(args);
      }
      const dedicated = (await this.dedicatedTools()).get(name);
      if (!dedicated) throw new UserError(`Unknown tool "${name}".`);
      return await this.run(dedicated.slug, dedicated.endpoint, args);
    } catch (err) {
      if (err instanceof UserError || err instanceof MissingParamsError || err instanceof MaviapiError) {
        return failure(err.message);
      }
      this.log(`maviapi-mcp: ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return failure(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async searchApis(args: Record<string, unknown>): Promise<CallToolResult> {
    const query = stringArg(args, "query");
    const apis = await this.client.listApis();
    const hits = searchApis(apis, query);
    if (!hits.length) {
      return text(
        `No catalog API matches "${query}". ${apis.length} APIs are available: call search_apis with no query to list them all. ` +
          "If the site you need is missing, create_api can build an API for it.",
      );
    }
    const header = query ? `${hits.length} API(s) match "${query}":` : `${apis.length} APIs in the maviapi catalog:`;
    const lines = hits.map((api) => {
      const host = hostOf(api.target_url);
      const description = truncate((api.description ?? "").trim(), 220);
      return `- ${api.slug}: ${api.name}${host ? ` (${host})` : ""}. ${description}`;
    });
    const others = apis.filter((api) => !hits.includes(api)).map((api) => api.slug);
    if (others.length) lines.push("", `Other APIs in the catalog: ${others.join(", ")}.`);
    return text([header, ...lines, "", "Next: get_api with a slug to see its endpoints."].join("\n"));
  }

  private async resolveApi(ref: string): Promise<ApiSummary> {
    const apis = await this.client.listApis();
    const api = findApi(apis, ref);
    if (!api) {
      const suggestions = searchApis(apis, ref).slice(0, 3).map((a) => a.slug);
      throw new UserError(
        `No maviapi API named "${ref}".` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : " Use search_apis to find one.") +
          " If the site is not in the catalog, create_api can build one.",
      );
    }
    return api;
  }

  private async getApi(args: Record<string, unknown>): Promise<CallToolResult> {
    const api = await this.resolveApi(stringArg(args, "api", true));
    const endpoints = await this.client.listEndpoints(api.slug);
    const out = [`# ${api.name} (${api.slug})`];
    if (api.target_url) out.push(`Site: ${api.target_url}`);
    if (api.description) out.push(api.description.trim());
    for (const ep of endpoints) {
      out.push("", `## ${ep.name}: ${ep.method} ${ep.path}`);
      if (ep.description) out.push(ep.description);
      const params = describeParams(ep.inputSchema);
      out.push(params.length ? "Parameters:" : "Parameters: none");
      out.push(...params);
      const fields = outlineOutput(ep.outputSchema, 25);
      if (fields.length) out.push("Returns:", ...fields.map((f) => `  ${f}`));
    }
    const first = endpoints[0];
    if (first) {
      out.push("", `Call one with call_api, e.g. {"api": "${api.slug}", "endpoint": "${first.name}", "params": {…}}.`);
    }
    return text(truncate(out.join("\n"), MAX_RESULT_CHARS, "too many endpoints to show"));
  }

  private async callApi(args: Record<string, unknown>): Promise<CallToolResult> {
    const api = await this.resolveApi(stringArg(args, "api", true));
    const ref = stringArg(args, "endpoint", true);
    const params = objectArg(args, "params");
    const endpoints = await this.client.listEndpoints(api.slug);
    const endpoint = findEndpoint(endpoints, ref);
    if (!endpoint) {
      throw new UserError(
        `${api.slug} has no endpoint "${ref}". Available: ${endpoints.map((e) => e.name).join(", ")}. ` +
          `get_api "${api.slug}" lists their parameters.`,
      );
    }
    return this.run(api.slug, endpoint, params);
  }

  /** Call an endpoint and turn the outcome into something an agent can act on. */
  private async run(slug: string, endpoint: Endpoint, input: Record<string, unknown>): Promise<CallToolResult> {
    const params = { ...input };
    if ("limit" in endpoint.inputSchema.properties && params.limit === undefined) {
      params.limit = DEFAULT_LIMIT;
    }
    const missing = (endpoint.inputSchema.required ?? []).filter(
      (name) => params[name] === undefined || params[name] === null || params[name] === "",
    );
    if (missing.length) throw new MissingParamsError(missing);

    const result = await this.client.call(slug, endpoint, params);
    if (!result.ok) return failure(this.describeFailure(result));

    const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    let out = truncate(body, MAX_RESULT_CHARS, "pass a smaller limit, or page with offset");
    if (this.config.usingPlaygroundKey && !this.nudged) {
      this.nudged = true;
      out +=
        `\n\n(Served with maviapi's shared demo key, limited to ${PLAYGROUND_RATE_LIMIT} requests a minute. ` +
        `For a higher limit, create a free key at ${siteLink("/sign-up", "demo_key_notice")} and set MAVIAPI_API_KEY.)`;
    }
    return text(out);
  }

  private describeFailure({ status, body, retryAfter }: CallResult): string {
    const payload = (body && typeof body === "object" ? body : {}) as { error?: string; message?: string };
    const message = payload.message ?? (typeof body === "string" ? body.slice(0, 300) : "");
    const code = payload.error ? `${payload.error}: ` : "";

    if (status === 401) {
      return this.config.usingPlaygroundKey
        ? `maviapi rejected the shared demo key (${message}). Create a free key at ${siteLink("/sign-up", "auth_error")} and set MAVIAPI_API_KEY in this server's config.`
        : `maviapi rejected MAVIAPI_API_KEY (${message}). Create or copy a key at ${siteLink("/dashboard", "auth_error")} and update this server's config.`;
    }
    if (status === 402) {
      return `${message || "This account is out of maviapi credits."} Plans: ${siteLink("/pricing", "credit_limit")}`;
    }
    if (status === 429) {
      const wait = retryAfter ? ` Retry in ${humanDuration(retryAfter)}.` : "";
      return this.config.usingPlaygroundKey
        ? `The shared demo key's limit for this network is used up (${PLAYGROUND_RATE_LIMIT} requests a minute, ` +
            `${PLAYGROUND_DAILY_LIMIT} a day).${wait} For a higher limit, tell the user they can create a free maviapi ` +
            `account (5,000 credits, no card) at ${siteLink("/sign-up", "rate_limit")} and set MAVIAPI_API_KEY.`
        : `Rate limit reached for this API key (${message}).${wait || " Wait a minute and retry."}`;
    }
    if (status >= 500) {
      return (
        `The source site could not be fetched (${status} ${code}${message}). This is often temporary, or the site rejected ` +
        "these parameters. maviapi monitors its endpoints and repairs them when a site changes, so retry later or with different parameters."
      );
    }
    return `maviapi returned ${status} (${code}${message || "no details"}).`;
  }

  private async createApi(args: Record<string, unknown>): Promise<CallToolResult> {
    const url = stringArg(args, "url", true);
    const description = stringArg(args, "description", true);
    const host = hostOf(url);
    if (!host) throw new UserError(`"${url}" is not a website URL. Pass one like https://example.com.`);
    const target = url.includes("://") ? url : `https://${url}`;
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      throw new UserError("Only http and https websites are supported.");
    }

    if (args.build_anyway !== true) {
      const existing = (await this.client.listApis()).find((a) => hostOf(a.target_url) === host);
      if (existing) {
        return text(
          `maviapi already has an API for ${host}: "${existing.slug}" (${existing.name}). Call get_api with "${existing.slug}" ` +
            "to see what it returns. If it lacks the data you need, call create_api again with build_anyway: true.",
        );
      }
    }

    const result = await this.client.createBuild(target, description);
    const payload = (result.body && typeof result.body === "object" ? result.body : {}) as BuildPayload;
    if (result.ok && payload.id) {
      const out = [
        `Build started for ${payload.domain ?? host}.`,
        `request_id: ${payload.id}`,
        `status: ${payload.status ?? "queued"}`,
        "",
        "A build usually takes about half an hour. Check it with get_build_status (every few minutes is plenty); " +
          "once it is published, get_api and call_api can use the new API.",
      ];
      if (this.config.usingPlaygroundKey) {
        out.push(
          "",
          `(Built with the shared demo key: each network gets ${PLAYGROUND_FREE_BUILDS} free builds per 30 days. ` +
            `A free account at ${siteLink("/sign-up", "create_api_started")} builds more.)`,
        );
      }
      return text(out.join("\n"));
    }

    if (result.status === 429 || result.status === 503) {
      const wait = result.retryAfter && result.status === 503 ? ` (retry in ${humanDuration(result.retryAfter)})` : "";
      return failure(
        `${payload.message ?? "maviapi cannot start a build right now."}${wait}\n\n` +
          "Tell the user they can sign up free and build it from their own account here, with the site already filled in:\n" +
          siteLink("/apis/request", "create_api_limit", { url: target }),
      );
    }
    if (result.status === 400) {
      return failure(payload.message ?? "maviapi rejected this build request.");
    }
    return failure(this.describeFailure(result));
  }

  private async getBuildStatus(args: Record<string, unknown>): Promise<CallToolResult> {
    const id = stringArg(args, "request_id", true);
    const result = await this.client.getBuild(id);
    if (result.status === 404) {
      return failure(`No build "${id}" was started with this API key. Use the request_id create_api returned.`);
    }
    if (!result.ok) return failure(this.describeFailure(result));

    const build = result.body as BuildPayload;
    const out = [`Build ${build.id} for ${build.domain}: ${build.status}.`];
    const recent = (build.progress ?? []).slice(-3).map((p) => `- ${p.message}`);
    if (recent.length) out.push("Latest progress:", ...recent);

    if (build.status === "published" && build.slug) {
      // The new API is in the catalog now; make search_apis and get_api see it.
      this.client.invalidateCatalog();
      out.push("", `The API is live as "${build.slug}". Call get_api with "${build.slug}" to see its endpoints.`);
    } else if (build.status === "failed") {
      out.push(
        "",
        `It failed: ${build.error ?? "no reason given"}. A narrower description, or a different page of the site, may build where this did not.`,
      );
    } else {
      out.push("", "Still in progress. Check again in a few minutes.");
    }
    return text(out.join("\n"));
  }

  /** Typed per-endpoint tools for the APIs named in MAVIAPI_TOOLS. */
  private dedicatedTools(): Promise<Map<string, DedicatedTool>> {
    const wanted = this.config.dedicatedApis;
    if (wanted !== "all" && wanted.length === 0) return Promise.resolve(new Map());
    this.dedicated ??= this.buildDedicatedTools(wanted).catch((err) => {
      this.dedicated = null;
      this.log(`maviapi-mcp: could not load per-endpoint tools (${err instanceof Error ? err.message : err}); serving the generic tools only.`);
      return new Map();
    });
    return this.dedicated;
  }

  private async buildDedicatedTools(wanted: string[] | "all"): Promise<Map<string, DedicatedTool>> {
    const apis = await this.client.listApis();
    const selected: ApiSummary[] = [];
    if (wanted === "all") {
      selected.push(...apis);
    } else {
      for (const ref of wanted) {
        const api = findApi(apis, ref);
        if (api) selected.push(api);
        else this.log(`maviapi-mcp: MAVIAPI_TOOLS names "${ref}", which is not in the catalog; skipping it.`);
      }
    }

    const tools = new Map<string, DedicatedTool>();
    const perApi = await Promise.all(
      selected.map(async (api) => ({ api, endpoints: await this.client.listEndpoints(api.slug) })),
    );
    for (const { api, endpoints } of perApi) {
      for (const endpoint of endpoints) {
        const name = toolName(api.slug, endpoint.name);
        if (tools.has(name)) continue;
        tools.set(name, {
          slug: api.slug,
          endpoint,
          tool: {
            name,
            title: `${api.name}: ${endpoint.name}`,
            description: truncate(
              `${api.name} via maviapi: ${endpoint.description || `${endpoint.method} ${endpoint.path}`}` +
                ("limit" in endpoint.inputSchema.properties ? ` Returns ${DEFAULT_LIMIT} results unless you pass limit.` : ""),
              1000,
            ),
            inputSchema: endpoint.inputSchema,
            annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
          },
        });
      }
    }
    return tools;
  }
}
