import { buildQuery, fillPath, normalizeEndpoint, type ApiSummary, type Endpoint, type RawEndpoint } from "./catalog.js";
import { VERSION, type Config } from "./config.js";

/** How long catalog and endpoint listings are reused before refetching. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Bot-protected sources go through a real browser and can take a while. */
const CALL_TIMEOUT_MS = 120_000;
const CATALOG_TIMEOUT_MS = 20_000;

export interface CallResult {
  status: number;
  ok: boolean;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  body: unknown;
  /** The build that served the call (the `x-maviapi-version` header). */
  build: string | null;
  /** Seconds to wait before retrying, from a refusal's `Retry-After`. */
  retryAfter: number | null;
}

export class MaviapiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

interface Cached<T> {
  value: Promise<T>;
  expires: number;
}

export class MaviapiClient {
  private catalog: Cached<ApiSummary[]> | null = null;
  private endpoints = new Map<string, Cached<Endpoint[]>>();

  constructor(
    readonly config: Config,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Every API in the public catalog. */
  listApis(): Promise<ApiSummary[]> {
    if (!this.catalog || this.catalog.expires < Date.now()) {
      const value = this.getJson<ApiSummary[]>("/v1/apis");
      this.catalog = { value, expires: Date.now() + CACHE_TTL_MS };
      value.catch(() => (this.catalog = null));
    }
    return this.catalog.value;
  }

  /** An API's endpoints on its active build, with their input and output schemas. */
  listEndpoints(slug: string): Promise<Endpoint[]> {
    const hit = this.endpoints.get(slug);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = this.getJson<RawEndpoint[]>(
      `/v1/apis/${encodeURIComponent(slug)}/endpoints?include=schemas`,
    ).then((rows) => rows.map(normalizeEndpoint));
    this.endpoints.set(slug, { value, expires: Date.now() + CACHE_TTL_MS });
    value.catch(() => this.endpoints.delete(slug));
    return value;
  }

  /** Drop the cached catalog before checking whether an API is public. */
  invalidateCatalog(): void {
    this.catalog = null;
  }

  /** Ask maviapi to build an API for a website (POST /v1/requests). */
  createBuild(targetUrl: string, prompt: string | undefined): Promise<CallResult> {
    return this.send("POST", "/v1/requests", { targetUrl, ...(prompt && { prompt }) });
  }

  /** A build started with this key (GET /v1/requests/:id). */
  getBuild(id: string): Promise<CallResult> {
    return this.send("GET", `/v1/requests/${encodeURIComponent(id)}`);
  }

  /** Call one endpoint through the maviapi gateway, on the live build or on `version`. */
  async call(
    slug: string,
    endpoint: Endpoint,
    params: Record<string, unknown>,
    version?: number,
  ): Promise<CallResult> {
    const { path, query } = fillPath(endpoint.path, params);
    return this.send(
      endpoint.method,
      `/v1/sites/${encodeURIComponent(slug)}${path}${buildQuery(query)}`,
      undefined,
      version === undefined ? {} : { "x-maviapi-version": String(version) },
    );
  }

  /** Drop what is cached about one API, after a request changed it. */
  invalidateApi(slug: string): void {
    this.endpoints.delete(slug);
    this.catalog = null;
  }

  /** Each endpoint's current health (GET /v1/apis/:slug/health). */
  apiHealth(slug: string): Promise<CallResult> {
    return this.send("GET", `/v1/apis/${encodeURIComponent(slug)}/health`);
  }

  /** The endpoints being built for an API right now (GET /v1/apis/:slug/endpoint-requests). */
  buildingEndpoints(slug: string): Promise<CallResult> {
    return this.send("GET", `/v1/apis/${encodeURIComponent(slug)}/endpoint-requests`);
  }

  /** Every build of an API, newest first, with what changed (GET /v1/apis/:slug/changelog). */
  changelog(slug: string): Promise<CallResult> {
    return this.send("GET", `/v1/apis/${encodeURIComponent(slug)}/changelog`);
  }

  /** Ask for one endpoint on a public API, or dry-run the ask (POST /v1/me/apis/:slug/endpoint-requests). */
  askEndpoint(slug: string, ask: Record<string, unknown>): Promise<CallResult> {
    return this.send("POST", `/v1/me/apis/${encodeURIComponent(slug)}/endpoint-requests`, ask);
  }

  /** Report an endpoint that answers wrongly (POST /v1/me/apis/:slug/endpoint-reports). */
  reportEndpoint(slug: string, report: Record<string, unknown>): Promise<CallResult> {
    return this.send("POST", `/v1/me/apis/${encodeURIComponent(slug)}/endpoint-reports`, report);
  }

  /** The key owner's reports and where each stands (GET /v1/me/endpoint-reports). */
  listReports(): Promise<CallResult> {
    return this.send("GET", "/v1/me/endpoint-reports");
  }

  /** The key owner's requests (GET /v1/me/requests). */
  listRequests(filter: { slug?: string; status?: string }): Promise<CallResult> {
    return this.send("GET", `/v1/me/requests${buildQuery(filter)}`);
  }

  /** Where a request is; `wait` holds the call until `state` no longer matches (GET /v1/me/requests/:id/status). */
  requestStatus(id: string, wait = 0, state?: string): Promise<CallResult> {
    const query = buildQuery({ ...(wait > 0 && { wait }), ...(wait > 0 && state && { state }) });
    return this.send("GET", `/v1/me/requests/${encodeURIComponent(id)}/status${query}`);
  }

  /** Say something to the build of a request (POST /v1/me/requests/:id/messages). */
  sendRequestMessage(id: string, text: string): Promise<CallResult> {
    return this.send("POST", `/v1/me/requests/${encodeURIComponent(id)}/messages`, { text });
  }

  /** Release every endpoint of a request that passed (POST /v1/me/requests/:id/publish). */
  publishRequest(id: string): Promise<CallResult> {
    return this.send("POST", `/v1/me/requests/${encodeURIComponent(id)}/publish`, {});
  }

  /** Stop the build running for a request (POST /v1/me/requests/:id/cancel). */
  cancelRequest(id: string): Promise<CallResult> {
    return this.send("POST", `/v1/me/requests/${encodeURIComponent(id)}/cancel`, {});
  }

  /** Call an endpoint of a draft before it is published (GET /v1/drafts/:draftId/<path>). */
  callDraft(draftId: string, path: string, params: Record<string, unknown>): Promise<CallResult> {
    const filled = fillPath(path, params);
    return this.send("GET", `/v1/drafts/${encodeURIComponent(draftId)}${filled.path}${buildQuery(filled.query)}`);
  }

  /** What this key is and may do (GET /v1/me/key). */
  keyInfo(): Promise<CallResult> {
    return this.send("GET", "/v1/me/key");
  }

  /** An authenticated request; the outcome is returned, never thrown, so callers can explain it. */
  private async send(
    method: string,
    path: string,
    json?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<CallResult> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}`, ...extraHeaders };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.request(`${this.config.baseUrl}${path}`, CALL_TIMEOUT_MS, {
      method,
      headers,
      ...(json !== undefined && { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: hand the text back as is.
    }
    const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    return {
      status: res.status,
      ok: res.ok,
      body,
      build: res.headers.get("x-maviapi-version"),
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.request(`${this.config.baseUrl}${path}`, CATALOG_TIMEOUT_MS);
    if (!res.ok) {
      throw new MaviapiError(`maviapi catalog request failed (${res.status} on ${path})`, res.status);
    }
    return (await res.json()) as T;
  }

  private async request(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: "application/json",
          "User-Agent": `maviapi-mcp/${VERSION}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new MaviapiError(`maviapi did not answer within ${timeoutMs / 1000}s. Try again.`);
      }
      throw new MaviapiError(
        `Could not reach maviapi (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }
}
