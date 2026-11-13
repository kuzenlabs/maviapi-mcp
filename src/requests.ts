import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { findEndpoint, truncate, type ApiSummary } from "./catalog.js";
import type { CallResult, MaviapiClient } from "./client.js";
import { siteLink, type Config } from "./config.js";
import { MAX_RESULT_CHARS, UserError, failure, humanDuration, objectArg, stringArg, text } from "./result.js";

/**
 * The request tools: ask for an endpoint on an API that exists, follow its
 * build, try the draft, publish it, cancel it. They drive the same routes the
 * maviapi dashboard does, with the user's own API key. Every rule (who may
 * publish, one build per API, the daily limits) is the backend's; these tools
 * only word its answers for an agent.
 */

/** Longest one-sentence summary the backend keeps for an endpoint. */
const SUMMARY_MAX = 300;
/** Longest a status tool call waits, under the tool timeouts MCP clients use. */
export const MAX_WAIT_SECONDS = 50;
/** Longest one status request is held by the backend. */
const SERVER_WAIT_SECONDS = 30;

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const REQUEST_TOOLS: Tool[] = [
  {
    name: "request_endpoint",
    title: "Ask for a new maviapi endpoint",
    description:
      "Add one endpoint to an API that already exists, or a changed version of one of its endpoints. " +
      "Use it when get_api shows the API lacks the data, or an endpoint returns the wrong thing. " +
      "Existing endpoints never change: a change ships as a new endpoint beside the old one (e.g. /search-v2). " +
      "Without `confirm` nothing is built: the tool answers with the endpoint as it would be built, for the user to agree to. " +
      "Call it again with the same arguments and `confirm: true` to start the build (about half an hour). " +
      "One build of an API runs at a time: a request made while another is building waits in line and starts on its own. " +
      "Needs an API key with the requests:write permission. Follow the build with get_build_status.",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: 'API slug (e.g. "booking") or the site\'s domain.' },
        description: {
          type: "string",
          description:
            "What the endpoint returns, as specific as you can: the page it reads, the fields per record, the parameters. " +
            'E.g. "The reviews of one hotel, newest first: author, rating, date, text. Parameter: hotel id."',
        },
        path: {
          type: "string",
          description: 'For a new endpoint: its path, lowercase with dashes, no parameters in it. E.g. "/reviews" or "/hotel-photos".',
        },
        change: {
          type: "string",
          description: 'For a changed version of an existing endpoint: that endpoint\'s name or path, e.g. "/search". Use instead of `path`.',
        },
        confirm: { type: "boolean", description: "true starts the build. Leave it out to preview first." },
      },
      required: ["api", "description"],
    },
    annotations: WRITE,
  },
  {
    name: "list_requests",
    title: "List my maviapi requests",
    description:
      "The API and endpoint requests made with this account, newest first, with their status. " +
      "Filter by `api` (slug) or `status` (queued, building, deploying, published, failed). Needs an API key with a request permission.",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: "Only requests for this API slug." },
        status: { type: "string", description: "Only requests in this status." },
      },
    },
    annotations: READ,
  },
  {
    name: "send_request_message",
    title: "Message a maviapi build",
    description:
      "Say something to the build of a request, in plain words: add detail, ask it to fix or drop an endpoint that failed, " +
      'or to try again after a failure (e.g. "fix /reviews", "also return the review date", "try again"). ' +
      "Returns the build's answer. Needs an API key with the requests:write permission.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request_id from request_endpoint or create_api." },
        message: { type: "string", description: "What to tell the build." },
      },
      required: ["request_id", "message"],
    },
    annotations: WRITE,
  },
  {
    name: "call_draft",
    title: "Call a draft maviapi endpoint",
    description:
      "Call an endpoint of a request's draft before it is published, to check it returns the right data. " +
      "Only endpoints get_build_status shows as ready answer. Draft calls cost no credits. Needs an API key with a request permission.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request_id from request_endpoint or create_api." },
        endpoint: { type: "string", description: 'The endpoint path as get_build_status lists it, e.g. "/reviews".' },
        params: { type: "object", description: "Endpoint parameters, path parameters included.", additionalProperties: true },
      },
      required: ["request_id", "endpoint"],
    },
    annotations: { ...READ, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "publish_request",
    title: "Publish a maviapi request",
    description:
      "Make a finished request live: every endpoint that passed its checks becomes part of the public API. " +
      "Publishing changes what everyone who calls the API gets, so do it only when the user asked for it. " +
      "Works once get_build_status says the request is ready. Needs an API key with the requests:publish permission.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request_id from request_endpoint or create_api." },
      },
      required: ["request_id"],
    },
    annotations: { ...WRITE, idempotentHint: true },
  },
  {
    name: "cancel_request",
    title: "Cancel a maviapi build",
    description:
      "Stop the build that is running for a request. What was built before stays as it was. Needs an API key with the requests:write permission.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request_id from request_endpoint or create_api." },
      },
      required: ["request_id"],
    },
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "report_endpoint_issue",
    title: "Report a broken maviapi endpoint",
    description:
      "Tell maviapi that an endpoint that exists returns the wrong thing: it fails, comes back empty, or repeats the same page. " +
      "Use this instead of asking for a changed version when the endpoint is simply broken: the fix lands on the endpoint itself, for everyone. " +
      "maviapi replays the call at once and then runs its own check of the endpoint. If that check fails too the report is confirmed and the endpoint is queued for repair; " +
      "if not (a fault only certain parameters show, a repeated page, wrong values) a person on the team reads the report. " +
      "A report's status is confirmed, fixed or received. " +
      "Pass the `params` of a call that shows the fault. Without `endpoint` and `description` it lists the reports made with this key. " +
      "Needs an API key with the requests:write permission (any request permission to list).",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: 'API slug (e.g. "booking") or the site\'s domain.' },
        endpoint: { type: "string", description: 'The endpoint\'s name or path, e.g. "/restaurants".' },
        description: {
          type: "string",
          description:
            'What is wrong, in a sentence or two: what you asked for, what came back, what you expected. E.g. "page=2 returns the same 30 restaurants as page 1."',
        },
        params: {
          type: "object",
          description: 'The parameters of a call that shows the fault, e.g. {"geo": "187147", "page": 2}.',
          additionalProperties: true,
        },
      },
    },
    annotations: WRITE,
  },
  {
    name: "get_key_info",
    title: "Show this maviapi key",
    description:
      "What the configured API key may do: its permissions, the account's plan and remaining credits, and the limits that apply. " +
      "Check it before starting something that needs a permission or uses credits. Needs an API key with a request permission.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "get_changelog",
    title: "Show a maviapi API's versions",
    description:
      "Every version of an API, newest first: which is live, when it was built, and what changed (endpoints added or removed, fields changed). " +
      "Use it when an endpoint behaves differently than before, or to pick a version for call_api's `version`.",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: 'API slug (e.g. "booking") or the site\'s domain.' },
      },
      required: ["api"],
    },
    annotations: READ,
  },
];

const NAMES = new Set(REQUEST_TOOLS.map((t) => t.name));

/** Where a report stands, in the API's own sentence when it sent one. */
function describeReport(report: Record<string, unknown>): string {
  if (typeof report.message === "string" && report.message) return report.message;
  return `status ${String(report.status ?? "unknown")}`;
}

/** The status answer of GET /v1/me/requests/:id/status. */
export interface RequestStatus {
  id: string;
  kind?: string;
  domain?: string;
  slug?: string | null;
  asked?: { path: string; summary: string; of?: string };
  phase: string;
  state: string;
  publishable?: boolean;
  endpoints?: Array<{
    id: string;
    method: string;
    path: string;
    status: string;
    params?: Array<{ name: string; example: string; in: string }>;
    checks?: { summary: string; schemaFields: number; avgMs: number };
    failure?: { title: string; body: string };
  }>;
  messages?: Array<{ kind: string; text: string; code?: string }>;
  draft?: { id: string; baseUrl: string } | null;
  live?: { version: string; baseUrl: string } | null;
  error?: string | null;
}

const RUNNING = new Set(["queued", "reading", "mapping", "building", "testing"]);
/** Phases that change on their own, so waiting on them is worth it. */
const MOVING = new Set([...RUNNING, "publishing"]);

type Payload = Record<string, unknown>;

const payloadOf = (result: CallResult): Payload =>
  result.body && typeof result.body === "object" ? (result.body as Payload) : {};

/** An endpoint path as callers write it: "/reviews", whatever prefix or case it came with. */
export function shortPath(path: string, slug?: string | null): string {
  const prefix = slug ? `/v1/sites/${slug}` : "";
  const tail = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return tail.startsWith("/") ? tail : `/${tail}`;
}

/** What a request is for, in a few words. */
function subject(s: Pick<RequestStatus, "asked" | "slug" | "domain">): string {
  if (s.asked) {
    return s.asked.of
      ? `a changed GET ${s.asked.of} as GET ${s.asked.path} on ${s.slug}`
      : `new endpoint GET ${s.asked.path} on ${s.slug}`;
  }
  return `an API for ${s.domain}`;
}

/** One version's changes as a sentence. */
export function describeDiff(diff: unknown): string {
  if (!diff || typeof diff !== "object") return "";
  const d = diff as Record<string, unknown[] | undefined>;
  const list = (items: unknown[] | undefined, show: (item: never) => string) =>
    (items ?? []).map((i) => show(i as never)).join(", ");
  const parts: string[] = [];
  if (d.added_endpoints?.length) parts.push(`added ${list(d.added_endpoints, (p: string) => p)}`);
  if (d.removed_endpoints?.length) parts.push(`removed ${list(d.removed_endpoints, (p: string) => p)}`);
  if (d.removed_fields?.length) {
    parts.push(`fields removed: ${list(d.removed_fields, (f: { endpoint: string; path: string }) => `${f.endpoint} ${f.path}`)}`);
  }
  if (d.retyped_fields?.length) {
    parts.push(
      `fields changed type: ${list(d.retyped_fields, (f: { endpoint: string; path: string; from: string; to: string }) => `${f.endpoint} ${f.path} (${f.from} to ${f.to})`)}`,
    );
  }
  if (d.new_required_params?.length) {
    parts.push(
      `new required parameters: ${list(d.new_required_params, (p: { endpoint: string; param: string }) => `${p.endpoint} ${p.param}`)}`,
    );
  }
  return parts.join("; ");
}

export interface RequestToolsDeps {
  resolveApi: (ref: string) => Promise<ApiSummary>;
  /** The generic wording for a refused call (401, 402, 429, 5xx). */
  describeFailure: (result: CallResult) => string;
}

export class RequestTools {
  /** What each request looked like last: its state token is passed back so a wait returns on the next change. */
  private readonly states = new Map<string, { state: string; phase: string }>();

  constructor(
    private readonly client: MaviapiClient,
    private readonly config: Config,
    private readonly deps: RequestToolsDeps,
  ) {}

  handles(name: string): boolean {
    return NAMES.has(name);
  }

  /** True when the rich status route can be used: it needs the user's own key. */
  get available(): boolean {
    return !this.config.usingPlaygroundKey;
  }

  call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === "get_changelog") return this.getChangelog(args);
    this.requireOwnKey();
    switch (name) {
      case "request_endpoint":
        return this.requestEndpoint(args);
      case "list_requests":
        return this.listRequests(args);
      case "send_request_message":
        return this.sendMessage(args);
      case "call_draft":
        return this.callDraft(args);
      case "publish_request":
        return this.publish(args);
      case "cancel_request":
        return this.cancel(args);
      case "report_endpoint_issue":
        return this.reportIssue(args);
      case "get_key_info":
        return this.keyInfo();
    }
    throw new UserError(`Unknown tool "${name}".`);
  }

  private requireOwnKey(): void {
    if (this.available) return;
    throw new UserError(
      "This needs your own maviapi API key: the shared demo key cannot manage requests. " +
        `Create a free key at ${siteLink("/sign-up", "request_tools")} and set MAVIAPI_API_KEY in this server's config.`,
    );
  }

  /** The wording for a refusal of a request route; falls back to the generic one. */
  private refusal(result: CallResult): string {
    const body = payloadOf(result);
    const message = typeof body.message === "string" ? body.message : "";
    if (result.status === 403 && body.error === "missing_scope") {
      if (body.scope === "requests:publish") {
        return (
          "This API key may not publish (it has no requests:publish permission). " +
          `The user can publish from ${siteLink("/dashboard/requests", "missing_scope")}, or create a key with "Publish builds" turned on at ` +
          `${siteLink("/dashboard/keys", "missing_scope")} and set it as MAVIAPI_API_KEY.`
        );
      }
      return (
        "This API key only calls data APIs: it has no request permissions (requests:write). " +
        `The user can create a key with "Start and manage builds" turned on at ${siteLink("/dashboard/keys", "missing_scope")} ` +
        "and set it as MAVIAPI_API_KEY in this server's config."
      );
    }
    if (result.status === 403 && body.error === "session_required") {
      return "This maviapi deployment does not open that route to API keys.";
    }
    if (result.status === 429 && body.error !== "rate_limited") {
      const wait = result.retryAfter ? ` Try again in ${humanDuration(result.retryAfter)}.` : "";
      return `${message || "This account has started as many builds as it may for now."}${wait}`;
    }
    if ((result.status === 400 || result.status === 409 || result.status === 422) && message) return message;
    return this.deps.describeFailure(result);
  }

  private async requestEndpoint(args: Record<string, unknown>): Promise<CallToolResult> {
    const api = await this.deps.resolveApi(stringArg(args, "api", true));
    const description = stringArg(args, "description", true);
    const path = stringArg(args, "path");
    const change = stringArg(args, "change");
    if (!path && !change) {
      throw new UserError(
        'Pass `path` for a new endpoint (e.g. "/reviews"), or `change` with an existing endpoint to get a changed version of it.',
      );
    }
    if (path && change) throw new UserError("Pass `path` or `change`, not both.");

    const ask: Record<string, unknown> = { summary: truncate(description, SUMMARY_MAX) };
    // The whole description reaches the build even when the summary cut it.
    if (description.length > SUMMARY_MAX) ask.messages = [{ role: "user", content: description }];
    if (change) {
      const endpoints = await this.client.listEndpoints(api.slug);
      const existing = findEndpoint(endpoints, change);
      if (!existing) {
        throw new UserError(
          `${api.slug} has no endpoint "${change}" to change. Its endpoints: ${endpoints.map((e) => e.path).join(", ")}. ` +
            "For a new endpoint pass `path` instead.",
        );
      }
      ask.of = existing.path.toLowerCase();
    } else {
      ask.path = `/${path!.toLowerCase().replace(/^\/+/, "")}`;
    }

    const confirmed = args.confirm === true;
    const result = await this.client.askEndpoint(api.slug, confirmed ? ask : { ...ask, dryRun: true });
    const body = payloadOf(result);

    if (!result.ok) {
      if (result.status === 409 && body.error === "extension_in_progress") {
        const own = typeof body.requestId === "string" ? ` It is your own request: ${body.requestId}.` : "";
        return failure(
          `${String(body.message ?? "The line of requests for this API is full.")}${own} ` +
            "An API holds 3 requests at a time, so ask again once one has finished (builds take about half an hour).",
        );
      }
      return failure(this.refusal(result));
    }

    if (!confirmed) {
      const endpoint = (body.endpoint ?? {}) as { path?: string; summary?: string; of?: string };
      const out = [
        `Nothing has been built yet. This would add to ${api.name} (${api.slug}):`,
        `  GET ${endpoint.path}${endpoint.of ? ` (a changed version of GET ${endpoint.of}, which stays as it is)` : ""}`,
        `  ${endpoint.summary}`,
        "",
        "Show this to the user. If they agree, call request_endpoint again with the same arguments and confirm: true.",
        "A build takes about half an hour; an account can start 2 an hour and 5 a day.",
      ];
      if (body.accepted === false) {
        out.push(
          "",
          "Note: the line of requests for this API is full (3 at a time), so this one would be refused right now. Ask again once one of them has finished.",
        );
      } else if (body.building) {
        const ahead = typeof body.ahead === "number" && body.ahead > 1 ? ` and ${body.ahead - 1} more ahead of it` : "";
        out.push(
          "",
          `Note: GET ${String(body.building).replace(/^GET /, "")} is being built for this API right now${ahead}. ` +
            "One build runs at a time, so this one would wait in line and start on its own when they have finished.",
        );
      }
      return text(out.join("\n"));
    }

    const id = String(body.id ?? "");
    const built = (body.extension ?? {}) as { path?: string };
    const waitingFor = typeof body.waitingFor === "string" ? body.waitingFor : null;
    return text(
      [
        waitingFor
          ? `Request accepted: GET ${built.path ?? ask.path ?? ""} on ${api.slug}. It waits in line behind GET ${waitingFor.replace(/^GET /, "")} and starts building on its own when that has finished.`
          : `Build started: GET ${built.path ?? ask.path ?? ""} on ${api.slug}.`,
        `request_id: ${id}`,
        `status: ${String(body.status ?? "queued")}`,
        "",
        `Follow it with get_build_status {"request_id": "${id}", "wait_seconds": ${MAX_WAIT_SECONDS}}: it returns as soon as something changes.`,
        "When it is ready, try it with call_draft, then publish_request makes it live.",
      ].join("\n"),
    );
  }

  private async reportIssue(args: Record<string, unknown>): Promise<CallToolResult> {
    const endpointArg = stringArg(args, "endpoint");
    const description = stringArg(args, "description");
    if (!endpointArg && !description) return this.listReports();

    const api = await this.deps.resolveApi(stringArg(args, "api", true));
    if (!endpointArg || !description) {
      throw new UserError("Pass both `endpoint` (which one) and `description` (what is wrong).");
    }
    const endpoints = await this.client.listEndpoints(api.slug);
    const endpoint = findEndpoint(endpoints, endpointArg);
    if (!endpoint) {
      throw new UserError(
        `${api.slug} has no endpoint "${endpointArg}". Its endpoints: ${endpoints.map((e) => e.path).join(", ")}.`,
      );
    }
    const params = objectArg(args, "params");
    const result = await this.client.reportEndpoint(api.slug, {
      path: endpoint.path,
      description,
      ...(Object.keys(params).length > 0 && { params }),
    });
    const body = payloadOf(result);
    if (!result.ok) {
      if (result.status === 409 && body.error === "already_reported") {
        return failure(
          `${String(body.message ?? "You already reported this endpoint today.")} ` +
            "Call report_endpoint_issue with no arguments to see where that report stands.",
        );
      }
      return failure(this.refusal(result));
    }
    return text(
      [
        `Report ${String(body.id ?? "")} on GET ${endpoint.path} of ${api.slug}: ${describeReport(body)}`,
        ...(typeof body.found === "string" ? [`What maviapi saw: ${body.found}`] : []),
        "",
        body.status === "confirmed"
          ? "Nothing more to do: the endpoint keeps its path, so the same call works once it is repaired. " +
            "get_api shows the endpoint's health; report_endpoint_issue with no arguments shows where this report stands."
          : "If the fault only shows with certain parameters, they are in the report for the person who reads it. " +
            "If you need different behavior rather than a fix, request_endpoint with `change` builds a new version beside this one.",
      ].join("\n"),
    );
  }

  private async listReports(): Promise<CallToolResult> {
    const result = await this.client.listReports();
    if (!result.ok) return failure(this.refusal(result));
    const rows = (Array.isArray(payloadOf(result).reports) ? payloadOf(result).reports : []) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return text("No endpoint has been reported with this key's account.");
    return text(
      rows
        .map(
          (r) =>
            `${String(r.id)}  ${String(r.slug)} GET ${String(r.path)}  ${String(r.status)}\n  ${describeReport(r)}`,
        )
        .join("\n"),
    );
  }

  private async listRequests(args: Record<string, unknown>): Promise<CallToolResult> {
    const api = stringArg(args, "api");
    const status = stringArg(args, "status");
    const slug = api ? (await this.deps.resolveApi(api)).slug : undefined;
    const result = await this.client.listRequests({ ...(slug && { slug }), ...(status && { status }) });
    if (!result.ok) return failure(this.refusal(result));
    const rows = (Array.isArray(result.body) ? result.body : []) as Array<{
      id: string;
      domain?: string;
      slug?: string | null;
      status?: string;
      kind?: string;
      live?: boolean;
      extension?: { path: string; of?: string } | null;
      createdAt?: string;
    }>;
    if (!rows.length) {
      return text(
        `No requests${slug ? ` for ${slug}` : ""}${status ? ` with status ${status}` : ""} on this account. ` +
          "request_endpoint adds an endpoint to an API; create_api builds an API for a new site.",
      );
    }
    const lines = rows.slice(0, 50).map((r) => {
      const what = r.extension ? `GET ${r.extension.path} on ${r.slug}` : `API for ${r.domain}${r.slug ? ` (${r.slug})` : ""}`;
      // A finished build is not public until someone publishes it.
      const state = r.status === "published" ? (r.live ? "built, API is public" : "built, not published") : r.status;
      return `- ${r.id}: ${what}: ${state}${r.createdAt ? ` (${r.createdAt.slice(0, 10)})` : ""}`;
    });
    const more = rows.length > 50 ? [`(${rows.length - 50} older requests not shown)`] : [];
    return text([`${rows.length} request(s):`, ...lines, ...more, "", "get_build_status with a request_id shows one in detail."].join("\n"));
  }

  /**
   * The rich status of a request, waiting up to `waitSeconds` for a change.
   * Returns null when this deployment (or this key) has no such route, so the
   * caller can fall back to the plain build status.
   */
  async status(id: string, waitSeconds: number): Promise<{ result: CallResult; status: RequestStatus | null }> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const known = this.states.get(id);
      const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      // Wait only for a request that was last seen moving: a first look and a
      // settled request are answered at once.
      const wait = known && MOVING.has(known.phase) ? Math.min(left, SERVER_WAIT_SECONDS) : 0;
      const asked = Date.now();
      const result = await this.client.requestStatus(id, wait, known?.state);
      if (!result.ok) return { result, status: null };
      const status = result.body as RequestStatus;
      this.states.set(id, { state: status.state, phase: status.phase });
      const changed = !known || status.state !== known.state;
      if (changed || wait === 0 || deadline - Date.now() < 2000) return { result, status };
      // A backend that answered without holding the call: do not spin on it.
      if (Date.now() - asked < 1000) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /** A request's status as text an agent can act on. */
  describeStatus(s: RequestStatus): string {
    const out = [`Request ${s.id} (${subject(s)}): ${s.phase}.`];
    const endpoints = (s.endpoints ?? []).filter((e) => e.status !== "dropped");
    if (endpoints.length) {
      out.push("", "Endpoints:");
      for (const e of endpoints) {
        const params = (e.params ?? []).map((p) => `${p.name}${p.example ? `=${p.example}` : ""}`).join(", ");
        let line = `- ${e.method} ${shortPath(e.path, s.slug)}: ${e.status}`;
        if (e.checks) line += ` (${e.checks.summary}, ${e.checks.schemaFields} fields, ${e.checks.avgMs} ms)`;
        if (e.failure) line += `. ${e.failure.title}: ${e.failure.body}`;
        if (params && e.status === "ready") line += `. Parameters: ${params}`;
        out.push(line);
      }
    }
    const said = (s.messages ?? []).slice(-3).map((m) => `- ${m.text}${m.code ? ` ${m.code}` : ""}`);
    if (said.length) out.push("", "Latest from the build:", ...said);

    out.push("");
    const again = `get_build_status {"request_id": "${s.id}", "wait_seconds": ${MAX_WAIT_SECONDS}}`;
    if (s.phase === "queued") {
      out.push(`Waiting for a free build slot. Check again with ${again}.`);
    } else if (RUNNING.has(s.phase)) {
      out.push(`Still working. Check again with ${again}: it returns as soon as something changes.`);
    } else if (s.phase === "paused") {
      out.push('The site is rate limiting the build. send_request_message "continue slowly" or "retry" tells it how to go on.');
    } else if (s.phase === "ready") {
      out.push(
        "Built and tested, not public yet. Try an endpoint with call_draft. " +
          "When the user wants it live, publish_request publishes it " +
          `(or they can at ${siteLink(`/apis/request/${s.id}`, "request_ready")}).`,
      );
    } else if (s.phase === "publishing") {
      out.push(`Going live now, usually under a minute. Check again with ${again}.`);
    } else if (s.phase === "published") {
      out.push(
        `Live${s.live ? ` as ${s.live.version} at ${s.live.baseUrl}` : ""}. get_api "${s.slug}" shows it and call_api calls it.`,
      );
    } else if (s.phase === "failed") {
      out.push(
        `The build stopped: ${s.error ?? "no reason given"}. ` +
          'send_request_message "try again" builds it again; a narrower description may build where this did not.',
      );
    } else {
      out.push(
        "Nothing passed, so there is nothing to publish. The failures are above; " +
          'send_request_message can ask for a fix, e.g. "fix /reviews".',
      );
    }
    return out.join("\n");
  }

  private async loadStatus(id: string): Promise<RequestStatus> {
    const result = await this.client.requestStatus(id);
    if (result.status === 404) {
      throw new UserError(`No request "${id}" on this account. list_requests shows the ones there are.`);
    }
    if (!result.ok) throw new UserError(this.refusal(result));
    const status = result.body as RequestStatus;
    this.states.set(id, { state: status.state, phase: status.phase });
    return status;
  }

  private async sendMessage(args: Record<string, unknown>): Promise<CallToolResult> {
    const id = stringArg(args, "request_id", true);
    const message = stringArg(args, "message", true);
    const result = await this.client.sendRequestMessage(id, message);
    if (result.status === 404) {
      return failure(`No request "${id}" on this account. list_requests shows the ones there are.`);
    }
    // A refused change (409) still gets an answer in the build's own words.
    if (!result.ok && result.status !== 409) return failure(this.refusal(result));
    const status = await this.loadStatus(id);
    const reply = (status.messages ?? []).filter((m) => m.kind === "agent").at(-1);
    const out = [reply ? `The build answered: ${reply.text}` : "Sent.", "", this.describeStatus(status)];
    return result.ok ? text(out.join("\n")) : failure(out.join("\n"));
  }

  private async callDraft(args: Record<string, unknown>): Promise<CallToolResult> {
    const id = stringArg(args, "request_id", true);
    const ref = stringArg(args, "endpoint", true);
    const params = objectArg(args, "params");
    const status = await this.loadStatus(id);
    const wanted = shortPath(ref.replace(/^GET\s+/i, ""), status.slug).toLowerCase();
    const endpoints = (status.endpoints ?? []).filter((e) => e.status !== "dropped");
    const endpoint = endpoints.find((e) => shortPath(e.path, status.slug).toLowerCase() === wanted);
    if (!endpoint) {
      throw new UserError(
        `This request has no endpoint "${ref}". It has: ${endpoints.map((e) => shortPath(e.path, status.slug)).join(", ") || "none yet"}.`,
      );
    }
    if (endpoint.status !== "ready" || !status.draft) {
      throw new UserError(
        `GET ${shortPath(endpoint.path, status.slug)} is ${endpoint.status}, so it cannot be called yet. ` +
          "Only ready endpoints answer; get_build_status shows when it is.",
      );
    }
    // The build's own example stands in for a parameter the caller left out.
    const filled: Record<string, unknown> = { ...params };
    for (const p of endpoint.params ?? []) {
      if (p.in === "path" && filled[p.name] === undefined && p.example) filled[p.name] = p.example;
    }
    const result = await this.client.callDraft(status.draft.id, shortPath(endpoint.path, status.slug), filled);
    const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    const out = truncate(body, MAX_RESULT_CHARS, "pass a smaller limit, or page with offset");
    return result.ok
      ? text(out)
      : failure(`The draft answered ${result.status}: ${truncate(body, 2000)}`);
  }

  private async publish(args: Record<string, unknown>): Promise<CallToolResult> {
    const id = stringArg(args, "request_id", true);
    const result = await this.client.publishRequest(id);
    if (result.status === 404) {
      return failure(`No request "${id}" on this account. list_requests shows the ones there are.`);
    }
    if (result.ok) {
      const version = String(payloadOf(result).version ?? "");
      return text(
        `Publishing${version ? ` ${version}` : ""}. It goes live in under a minute. ` +
          `Confirm with get_build_status {"request_id": "${id}", "wait_seconds": ${MAX_WAIT_SECONDS}}: the phase turns to published.`,
      );
    }
    if (result.status === 409) {
      // The reason is the build's last message; the code alone says little.
      const status = await this.loadStatus(id);
      const reply = (status.messages ?? []).filter((m) => m.kind === "agent").at(-1);
      return failure(
        `Not published (${String(payloadOf(result).error ?? "refused")}). ${reply?.text ?? ""}\n\n${this.describeStatus(status)}`,
      );
    }
    return failure(this.refusal(result));
  }

  private async cancel(args: Record<string, unknown>): Promise<CallToolResult> {
    const id = stringArg(args, "request_id", true);
    const result = await this.client.cancelRequest(id);
    if (result.status === 404) {
      return failure(`No request "${id}" on this account. list_requests shows the ones there are.`);
    }
    if (!result.ok) return failure(this.refusal(result));
    const status = result.body as RequestStatus;
    if (status.state) this.states.set(id, { state: status.state, phase: status.phase });
    return text(`Cancelled. ${this.describeStatus(status)}`);
  }

  private async keyInfo(): Promise<CallToolResult> {
    const result = await this.client.keyInfo();
    if (!result.ok) return failure(this.refusal(result));
    const info = result.body as {
      key: { name: string; prefix: string; env: string; scopes: string[] };
      plan: { name: string };
      credits: { used: number; included: number; remaining: number; payAsYouGo?: boolean; periodEnd?: string };
      limits: {
        callsPerMinute: number;
        callsPerDay: number | null;
        newApiBuilds?: Record<string, number>;
        endpointRequests?: Record<string, number>;
      };
      pins?: Array<{ slug: string; version: number }>;
    };
    const can = (scope: string) => info.key.scopes.includes(scope);
    const rate = (r?: Record<string, number>) =>
      [r?.perHour && `${r.perHour} an hour`, r?.perDay && `${r.perDay} a day`].filter(Boolean).join(", ");
    const out = [
      `Key "${info.key.name}" (${info.key.prefix}, ${info.key.env}).`,
      "It can call every API" +
        (can("requests:write") ? ", start and manage builds" : "") +
        (can("requests:publish") ? ", and publish them" : "") +
        ".",
    ];
    if (!can("requests:write")) {
      out.push("It cannot ask for endpoints or manage builds (no requests:write permission).");
    }
    if (!can("requests:publish")) {
      out.push(
        `It cannot publish (no requests:publish permission): the user publishes at ${siteLink("/dashboard/requests", "key_info")}, or creates a key that may at ${siteLink("/dashboard/keys", "key_info")}.`,
      );
    }
    out.push(
      "",
      `Plan: ${info.plan.name}. Credits: ${info.credits.remaining} of ${info.credits.included} left` +
        (info.credits.periodEnd ? ` until ${info.credits.periodEnd.slice(0, 10)}` : "") +
        (info.credits.payAsYouGo ? " (calls past that are billed as you go)." : "."),
      `Limits: ${info.limits.callsPerMinute} calls a minute` +
        (info.limits.callsPerDay ? `, ${info.limits.callsPerDay} a day (test key)` : "") +
        `. Endpoint requests: ${rate(info.limits.endpointRequests) || "see the dashboard"}. New API builds: ${rate(info.limits.newApiBuilds) || "see the dashboard"}.`,
    );
    if (info.pins?.length) {
      out.push(`Pinned versions: ${info.pins.map((p) => `${p.slug} on v${p.version}`).join(", ")}.`);
    }
    return text(out.join("\n"));
  }

  private async getChangelog(args: Record<string, unknown>): Promise<CallToolResult> {
    const api = await this.deps.resolveApi(stringArg(args, "api", true));
    const result = await this.client.changelog(api.slug);
    if (!result.ok) return failure(this.deps.describeFailure(result));
    const entries = ((result.body as { entries?: unknown[] }).entries ?? []) as Array<{
      version: number;
      state: string;
      compat?: string;
      date?: string;
      hotfix_of?: number | null;
      diff?: unknown;
    }>;
    if (!entries.length) return text(`${api.name} (${api.slug}) has no recorded versions yet.`);
    const lines = entries.slice(0, 30).map((e) => {
      const tags = [e.state === "active" ? "live" : e.state, e.compat === "breaking" ? "breaking" : ""]
        .filter(Boolean)
        .join(", ");
      const changes = e.hotfix_of ? `repair of v${e.hotfix_of}` : describeDiff(e.diff);
      return `- v${e.version} (${tags}${e.date ? `, ${e.date.slice(0, 10)}` : ""})${changes ? `: ${changes}` : ""}`;
    });
    return text(
      [
        `${api.name} (${api.slug}) versions, newest first:`,
        ...lines,
        "",
        'call_api serves the live version; pass "version": <n> to call another one that is still callable.',
      ].join("\n"),
    );
  }
}
