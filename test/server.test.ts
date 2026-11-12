import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { PLAYGROUND_KEY, loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { fakeFetch } from "./fixtures.js";

async function connect(env: Record<string, string> = {}, fetchImpl = fakeFetch().impl) {
  const server = createServer(loadConfig(env), fetchImpl);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const first = result.content[0];
      return { text: first?.type === "text" ? first.text : "", isError: result.isError === true };
    },
  };
}

const GENERIC = ["search_apis", "get_api", "call_api", "create_api", "get_build_status"];
const REQUEST = [
  "request_endpoint",
  "list_requests",
  "send_request_message",
  "call_draft",
  "publish_request",
  "cancel_request",
  "report_endpoint_issue",
  "get_key_info",
  "get_changelog",
];

describe("tool list", () => {
  it("serves the generic and request tools and the workflow instructions", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...GENERIC, ...REQUEST]);
    expect(client.getInstructions()).toContain("search_apis");
  });

  it("adds typed per-endpoint tools for MAVIAPI_TOOLS", async () => {
    const { client } = await connect({ MAVIAPI_TOOLS: "booking, nosuchapi" });
    const { tools } = await client.listTools();
    const hotel = tools.find((t) => t.name === "booking_hotel");
    expect(tools.map((t) => t.name)).toEqual([...GENERIC, ...REQUEST, "booking_search", "booking_hotel"]);
    expect(hotel?.inputSchema.required).toEqual(["country", "slug"]);
    expect(tools.find((t) => t.name === "booking_search")?.description).toContain("Returns 10 results");
  });

  it("exposes every API with MAVIAPI_TOOLS=all", async () => {
    const { client } = await connect({ MAVIAPI_TOOLS: "all" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("airbnb_listing_by_id");
    expect(tools.map((t) => t.name)).toContain("hurriyet_latest");
  });
});

describe("search_apis / get_api", () => {
  it("lists and searches the catalog", async () => {
    const { call } = await connect();
    expect((await call("search_apis")).text).toContain("3 APIs in the maviapi catalog");
    const hit = await call("search_apis", { query: "rental" });
    expect(hit.text).toContain("- airbnb: Airbnb (airbnb.com)");
    expect(hit.text).not.toContain("- booking:");
    expect(hit.text).toContain("Other APIs in the catalog: booking, hurriyet.");
    expect((await call("search_apis", { query: "flights" })).text).toContain("create_api");
  });

  it("describes endpoints, parameters and response fields", async () => {
    const { call } = await connect();
    const { text, isError } = await call("get_api", { api: "booking.com" });
    expect(isError).toBe(false);
    expect(text).toContain("# Booking.com (booking)");
    expect(text).toContain("## search: GET /search");
    expect(text).toContain('- location (string, required): City or region. Example: "Istanbul"');
    expect(text).toContain("data.hotels[].price: number");
    expect(text).toContain("## hotel: GET /hotel/{country}/{slug}");
    expect(text).not.toContain("refresh");
  });

  it("suggests close matches for an unknown API", async () => {
    const { call } = await connect();
    const res = await call("get_api", { api: "airbnbb rental" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Did you mean: airbnb?");
  });
});

describe("call_api", () => {
  it("fills path params, defaults the limit, and authenticates with the demo key", async () => {
    const fetch = fakeFetch();
    const { call } = await connect({}, fetch.impl);
    const res = await call("call_api", {
      api: "booking",
      endpoint: "search",
      params: { location: "Istanbul" },
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('{"data":{"ok":true}}');
    expect(res.text).toContain("shared demo key");

    const sent = fetch.calls.at(-1)!;
    expect(sent.url.pathname).toBe("/v1/sites/booking/search");
    expect(sent.url.searchParams.get("location")).toBe("Istanbul");
    expect(sent.url.searchParams.get("limit")).toBe("10");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${PLAYGROUND_KEY}`);
    expect(sent.headers.get("user-agent")).toMatch(/^maviapi-mcp\//);

    // The demo-key notice is shown once per session, not on every result.
    expect((await call("call_api", { api: "booking", endpoint: "search", params: { location: "Rome" } })).text).not.toContain(
      "shared demo key",
    );
  });

  it("uses MAVIAPI_API_KEY without the demo notice, and accepts params as a JSON string", async () => {
    const fetch = fakeFetch();
    const { call } = await connect({ MAVIAPI_API_KEY: "mvk_live_abc" }, fetch.impl);
    const res = await call("call_api", { api: "booking", endpoint: "/hotel/{country}/{slug}", params: '{"country":"tr","slug":"pera"}' });
    expect(res.text).not.toContain("demo key");
    const sent = fetch.calls.at(-1)!;
    expect(sent.url.pathname).toBe("/v1/sites/booking/hotel/tr/pera");
    expect(sent.url.search).toBe("");
    expect(sent.headers.get("authorization")).toBe("Bearer mvk_live_abc");
  });

  it("accepts the clean name, the raw catalog slug, or the path", async () => {
    const fetch = fakeFetch();
    const { call } = await connect({}, fetch.impl);
    for (const endpoint of ["listing_by_id", "listing/:id", "/listing/{id}"]) {
      expect((await call("call_api", { api: "airbnb", endpoint, params: { id: "7" } })).isError).toBe(false);
      expect(fetch.calls.at(-1)!.url.pathname).toBe("/v1/sites/airbnb/listing/7");
    }
  });

  it("keeps an explicit limit", async () => {
    const fetch = fakeFetch();
    const { call } = await connect({}, fetch.impl);
    await call("call_api", { api: "hurriyet", endpoint: "latest", params: { limit: 3 } });
    expect(fetch.calls.at(-1)!.url.searchParams.get("limit")).toBe("3");
  });

  it("refuses before calling when required params are missing", async () => {
    const fetch = fakeFetch();
    const { call } = await connect({}, fetch.impl);
    const res = await call("call_api", { api: "booking", endpoint: "hotel", params: { country: "tr" } });
    expect(res).toEqual({ isError: true, text: "Missing required parameter: slug" });
    expect(fetch.calls.some((c) => c.url.pathname.startsWith("/v1/sites/"))).toBe(false);
  });

  it("lists the real endpoints when the name is wrong", async () => {
    const { call } = await connect();
    const res = await call("call_api", { api: "booking", endpoint: "reviews" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Available: search, hotel");
  });

  it("turns the demo key's rate limit into a sign-up pointer", async () => {
    const fetch = fakeFetch(() => Response.json({ error: "rate_limited", message: "Rate limit exceeded" }, { status: 429 }));
    const { call } = await connect({}, fetch.impl);
    const res = await call("call_api", { api: "hurriyet", endpoint: "latest" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("30 requests a minute");
    expect(res.text).toContain("https://maviapi.com/sign-up?utm_source=mcp");
  });

  it("explains exhausted credits and upstream failures", async () => {
    const credits = fakeFetch(() =>
      Response.json({ error: "credit_limit_reached", message: "You've used all 5,000 credits." }, { status: 402 }),
    );
    const out = await (await connect({ MAVIAPI_API_KEY: "k" }, credits.impl)).call("call_api", { api: "hurriyet", endpoint: "latest" });
    expect(out.text).toContain("You've used all 5,000 credits. Plans: https://maviapi.com/pricing");

    const upstream = fakeFetch(() => Response.json({ error: "scrape_failed", message: "The upstream source could not be fetched" }, { status: 502 }));
    const res = await (await connect({}, upstream.impl)).call("call_api", { api: "hurriyet", endpoint: "latest" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("502 scrape_failed: The upstream source could not be fetched");
  });

  it("reports a network failure as a tool error", async () => {
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await (await connect({}, broken)).call("search_apis");
    expect(res).toEqual({ isError: true, text: "Could not reach maviapi (fetch failed)." });
  });
});

describe("dedicated tools", () => {
  it("calls the endpoint directly with typed arguments", async () => {
    const fetch = fakeFetch();
    const { call } = await connect({ MAVIAPI_TOOLS: "airbnb" }, fetch.impl);
    const res = await call("airbnb_listing_by_id", { id: "12345" });
    expect(res.isError).toBe(false);
    expect(fetch.calls.at(-1)!.url.pathname).toBe("/v1/sites/airbnb/listing/12345");
  });
});

describe("create_api / get_build_status", () => {
  const BUILD = {
    id: "req-1",
    status: "queued",
    domain: "news.ycombinator.com",
    targetUrl: "https://news.ycombinator.com",
    slug: null,
    error: null,
    progress: [],
  };

  /** A gateway that serves the build routes; `onBuild` answers POST /v1/requests. */
  function buildFetch(
    onBuild: () => Response,
    status: () => Record<string, unknown> = () => BUILD,
    catalog: () => Response | undefined = () => undefined,
  ) {
    return fakeFetch((url) => new Response("unused", { status: 500, statusText: url.pathname }), (url, init) => {
      if (url.pathname === "/v1/apis") return catalog();
      if (url.pathname === "/v1/requests" && init?.method === "POST") return onBuild();
      if (url.pathname === "/v1/requests/req-1") return Response.json(status());
      if (url.pathname.startsWith("/v1/requests/")) return Response.json({ error: "Not found" }, { status: 404 });
      return undefined;
    });
  }

  it("starts a build with the description and reports the request id", async () => {
    const fetch = buildFetch(() => Response.json(BUILD, { status: 201 }));
    const { call } = await connect({}, fetch.impl);
    const res = await call("create_api", { url: "news.ycombinator.com", description: "front-page stories with points" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("request_id: req-1");
    expect(res.text).toContain("3 free builds per 30 days");
    expect(res.text).toContain("does not give you an owner dashboard session");
    expect(res.text).not.toContain("once it is published, get_api and call_api");

    const sent = fetch.calls.find((c) => c.url.pathname === "/v1/requests")!;
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${PLAYGROUND_KEY}`);
    expect(JSON.parse(sent.body!)).toEqual({
      targetUrl: "https://news.ycombinator.com",
      prompt: "front-page stories with points",
    });
  });

  it("points at the existing API unless asked to build anyway", async () => {
    const fetch = buildFetch(() => Response.json({ ...BUILD, domain: "www.airbnb.com" }, { status: 201 }));
    const { call } = await connect({}, fetch.impl);
    const res = await call("create_api", { url: "https://www.airbnb.com/rooms/1", description: "reviews" });
    expect(res.text).toContain('maviapi already has an API for airbnb.com: "airbnb"');
    expect(fetch.calls.some((c) => c.url.pathname === "/v1/requests")).toBe(false);

    const forced = await call("create_api", { url: "https://www.airbnb.com", description: "reviews", build_anyway: true });
    expect(forced.text).toContain("request_id: req-1");
  });

  it("turns a used-up quota into a sign-up link with the site filled in", async () => {
    const fetch = buildFetch(() =>
      Response.json(
        { error: "build_limit_reached", message: "This network has used its 3 free API builds." },
        { status: 429, headers: { "retry-after": "2500000" } },
      ),
    );
    const { call } = await connect({}, fetch.impl);
    const res = await call("create_api", { url: "https://example.org", description: "everything" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("This network has used its 3 free API builds.");
    expect(res.text).toContain(
      "https://maviapi.com/apis/request?url=https%3A%2F%2Fexample.org&utm_source=mcp&utm_medium=mcp-server&utm_campaign=create_api_limit",
    );
  });

  it("says when to retry while every free slot is busy", async () => {
    const fetch = buildFetch(() =>
      Response.json({ error: "builds_busy", message: "Every free anonymous build slot is busy right now." }, {
        status: 503,
        headers: { "retry-after": "1800" },
      }),
    );
    const res = await (await connect({}, fetch.impl)).call("create_api", { url: "https://example.org", description: "x" });
    expect(res.text).toContain("busy right now. (retry in 30 minutes)");
  });

  it("requires a description and a website", async () => {
    const { call } = await connect();
    expect((await call("create_api", { url: "https://example.org" })).text).toBe("`description` is required.");
    expect((await call("create_api", { url: "not a site", description: "x" })).isError).toBe(true);
    expect((await call("create_api", { url: "ftp://files.example.com", description: "x" })).isError).toBe(true);
  });

  it("keeps completed private drafts distinct from public APIs and refreshes the catalog", async () => {
    let current: Record<string, unknown> = {
      ...BUILD,
      status: "building",
      progress: [{ state: "building", message: "Mapping the front page", at: "" }],
    };
    const fetch = buildFetch(() => Response.json(BUILD, { status: 201 }), () => current);
    const { call } = await connect({}, fetch.impl);

    const building = await call("get_build_status", { request_id: "req-1" });
    expect(building.text).toContain("Build req-1 for news.ycombinator.com: building.");
    expect(building.text).toContain("- Mapping the front page");
    expect(building.text).toContain("Check again in a few minutes");

    await call("search_apis");
    const catalogFetches = () => fetch.calls.filter((c) => c.url.pathname === "/v1/apis").length;
    const before = catalogFetches();
    current = { ...BUILD, status: "published", slug: "hackernews" };
    const done = await call("get_build_status", { request_id: "req-1" });
    expect(done.text).toContain('Build completed.');
    expect(done.text).toContain('API "hackernews" is not in the public catalog yet.');
    expect(done.text).not.toContain("The API is live");
    await call("search_apis");
    expect(catalogFetches()).toBe(before + 1);
  });

  it("does not confuse an existing public API with its new candidate build", async () => {
    const fetch = buildFetch(
      () => Response.json(BUILD, { status: 201 }),
      () => ({ ...BUILD, status: "published", slug: "airbnb" }),
    );
    const { call } = await connect({ MAVIAPI_API_KEY: "mvk_test_owner" }, fetch.impl);
    const done = await call("get_build_status", { request_id: "req-1" });
    expect(done.isError).toBe(false);
    expect(done.text).toContain('API "airbnb" is in the public catalog.');
    expect(done.text).toContain("this completed build may still await owner publication");
    expect(done.text).toContain("https://maviapi.com/dashboard/requests?");
    expect(done.text).not.toContain("The API is live");
  });

  it("preserves build completion when catalog availability cannot be verified", async () => {
    const fetch = buildFetch(
      () => Response.json(BUILD, { status: 201 }),
      () => ({ ...BUILD, status: "published", slug: "hackernews" }),
      () => Response.json({ error: "unavailable" }, { status: 503 }),
    );
    const done = await (await connect({}, fetch.impl)).call("get_build_status", { request_id: "req-1" });
    expect(done.isError).toBe(false);
    expect(done.text).toContain("Build completed.");
    expect(done.text).toContain("Could not verify public catalog visibility");
    expect(done.text).not.toContain("not in the public catalog yet");
    expect(done.text).not.toContain("The API is live");
  });

  it("does not keep polling a completed build with no slug", async () => {
    const fetch = buildFetch(
      () => Response.json(BUILD, { status: 201 }),
      () => ({ ...BUILD, status: "published", slug: null }),
    );
    const done = await (await connect({}, fetch.impl)).call("get_build_status", { request_id: "req-1" });
    expect(done.text).toContain("Build completed.");
    expect(done.text).not.toContain("Still in progress");
  });

  it("explains a failed build and an unknown id", async () => {
    const fetch = buildFetch(
      () => Response.json(BUILD, { status: 201 }),
      () => ({ ...BUILD, status: "failed", error: "The site blocked automated access." }),
    );
    const { call } = await connect({}, fetch.impl);
    expect((await call("get_build_status", { request_id: "req-1" })).text).toContain(
      "It failed: The site blocked automated access.",
    );
    const unknown = await call("get_build_status", { request_id: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No build "nope"');
  });
});
