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

  /** Drop the cached catalog, e.g. once a build has published a new API. */
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

  /** Call one endpoint through the maviapi gateway. */
  async call(slug: string, endpoint: Endpoint, params: Record<string, unknown>): Promise<CallResult> {
    const { path, query } = fillPath(endpoint.path, params);
    return this.send(endpoint.method, `/v1/sites/${encodeURIComponent(slug)}${path}${buildQuery(query)}`);
  }

  /** An authenticated request; the outcome is returned, never thrown, so callers can explain it. */
  private async send(method: string, path: string, json?: unknown): Promise<CallResult> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}` };
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
