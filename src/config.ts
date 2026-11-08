export const VERSION = "0.1.0";

export const DEFAULT_BASE_URL = "https://api.maviapi.com";
export const SITE_URL = "https://maviapi.com";

/**
 * maviapi's public playground key. maviapi.com ships it to every visitor's
 * browser so anyone can try the catalog without signing up, and the backend
 * throttles it per client IP. It lets this server work with zero setup; a
 * personal key (MAVIAPI_API_KEY) lifts the limit.
 */
export const PLAYGROUND_KEY = "mvk_test_playground_5f3c1a8d";

/** What the playground key allows from one network (one IPv4 address or IPv6 /64). */
export const PLAYGROUND_RATE_LIMIT = 30;
export const PLAYGROUND_DAILY_LIMIT = 300;
export const PLAYGROUND_FREE_BUILDS = 3;

export interface Config {
  baseUrl: string;
  apiKey: string;
  usingPlaygroundKey: boolean;
  /** APIs to expose as one typed tool per endpoint, on top of the generic tools. */
  dedicatedApis: string[] | "all";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.MAVIAPI_API_KEY?.trim();
  return {
    baseUrl: (env.MAVIAPI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: apiKey || PLAYGROUND_KEY,
    usingPlaygroundKey: !apiKey,
    dedicatedApis: parseToolList(env.MAVIAPI_TOOLS),
  };
}

function parseToolList(raw: string | undefined): string[] | "all" {
  const items = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.includes("all") ? "all" : items;
}

/** A maviapi.com link tagged so the site can attribute visits to this server. */
export function siteLink(path: string, campaign: string, params: Record<string, string> = {}): string {
  const url = new URL(path, SITE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("utm_source", "mcp");
  url.searchParams.set("utm_medium", "mcp-server");
  url.searchParams.set("utm_campaign", campaign);
  return url.toString();
}
