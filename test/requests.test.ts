import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { describeDiff, shortPath, type RequestStatus } from "../src/requests.js";
import { createServer } from "../src/server.js";
import { fakeFetch } from "./fixtures.js";

const KEY = "mvk_live_mine";

async function connect(fetchImpl: typeof fetch, env: Record<string, string> = { MAVIAPI_API_KEY: KEY }) {
  const server = createServer(loadConfig(env), fetchImpl);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    return { text: first?.type === "text" ? first.text : "", isError: result.isError === true };
  };
}

const STATUS: RequestStatus = {
  id: "req-9",
  kind: "extend",
  domain: "www.booking.com",
  slug: "booking",
  asked: { path: "/reviews", summary: "The reviews of one hotel." },
  phase: "building",
  state: "aaaa1111",
  publishable: false,
  endpoints: [
    {
      id: "e1",
      method: "GET",
      path: "/reviews",
      status: "building",
      params: [{ name: "id", example: "42", in: "query" }],
    },
  ],
  messages: [{ kind: "agent", text: "Reading the reviews page." }],
  draft: { id: "drf_abc", baseUrl: "https://api.maviapi.com/v1/drafts/drf_abc" },
  live: null,
  error: null,
};

const READY: RequestStatus = {
  ...STATUS,
  phase: "ready",
  state: "bbbb2222",
  publishable: true,
  endpoints: [
    {
      ...STATUS.endpoints![0]!,
      status: "ready",
      checks: { summary: "5 of 5 pages", schemaFields: 9, avgMs: 320 },
    },
  ],
};

/** A backend for the request routes. `routes` answers a "METHOD /path" key. */
function backend(routes: Record<string, (url: URL, body: Record<string, unknown>) => Response>) {
  return fakeFetch(
    () => Response.json({ data: { ok: true } }),
    (url, init) => {
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      const route = routes[key];
      if (!route) return undefined;
      return route(url, typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    },
  );
}

describe("request_endpoint", () => {
  const ASK = "POST /v1/me/apis/booking/endpoint-requests";

  it("previews the endpoint first and builds nothing", async () => {
    const fetch = backend({
      [ASK]: (_url, body) =>
        Response.json({ dryRun: true, slug: "booking", endpoint: { method: "GET", path: body.path, summary: body.summary }, building: null }),
    });
    const call = await connect(fetch.impl);
    const res = await call("request_endpoint", {
      api: "booking.com",
      path: "Reviews",
      description: "The reviews of one hotel, newest first.",
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Nothing has been built yet");
    expect(res.text).toContain("GET /reviews");
    expect(res.text).toContain("confirm: true");

    const sent = fetch.calls.find((c) => c.url.pathname.endsWith("/endpoint-requests") && c.method === "POST")!;
    expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(sent.body!)).toEqual({
      path: "/reviews",
      summary: "The reviews of one hotel, newest first.",
      dryRun: true,
    });
  });

  it("names a change to an existing endpoint, and says what is building", async () => {
    const fetch = backend({
      [ASK]: (_url, body) =>
        Response.json({
          dryRun: true,
          slug: "booking",
          endpoint: { method: "GET", path: "/search-v2", summary: body.summary, of: body.of },
          building: "/photos",
        }),
    });
    const call = await connect(fetch.impl);
    const res = await call("request_endpoint", {
      api: "booking",
      change: "search",
      description: "Search, with the price of every result.",
    });
    expect(res.text).toContain("GET /search-v2 (a changed version of GET /search, which stays as it is)");
    expect(res.text).toContain("GET /photos is being built for this API right now");
    const sent = fetch.calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(sent.body!)).toMatchObject({ of: "/search", dryRun: true });
  });

  it("starts the build once confirmed and sends a long description in full", async () => {
    const long = `The reviews of one hotel. ${"Each with author, rating, date and text. ".repeat(12)}`.trim();
    const fetch = backend({
      [ASK]: (_url, body) =>
        Response.json(
          { id: "req-9", status: "queued", kind: "extend", slug: "booking", extension: { path: body.path, summary: body.summary } },
          { status: 201 },
        ),
    });
    const call = await connect(fetch.impl);
    const res = await call("request_endpoint", { api: "booking", path: "/reviews", description: long, confirm: true });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Build started: GET /reviews on booking.");
    expect(res.text).toContain("request_id: req-9");
    expect(res.text).toContain("get_build_status");

    const body = JSON.parse(fetch.calls.find((c) => c.method === "POST")!.body!);
    expect(body.dryRun).toBeUndefined();
    expect(body.summary.length).toBeLessThanOrEqual(301);
    expect(body.messages).toEqual([{ role: "user", content: long }]);
  });

  it("says when a request waits in line, and when the line is full", async () => {
    const answers: Response[] = [
      Response.json({
        dryRun: true,
        slug: "booking",
        endpoint: { method: "GET", path: "/reviews", summary: "The reviews of one hotel." },
        building: "/photos",
        ahead: 2,
        accepted: true,
      }),
      Response.json(
        { id: "req-10", status: "queued", kind: "extend", slug: "booking", extension: { path: "/reviews" }, waitingFor: "/photos" },
        { status: 201 },
      ),
      Response.json({
        dryRun: true,
        slug: "booking",
        endpoint: { method: "GET", path: "/reviews", summary: "The reviews of one hotel." },
        building: "/photos",
        ahead: 3,
        accepted: false,
      }),
    ];
    const fetch = backend({ [ASK]: () => answers.shift()! });
    const call = await connect(fetch.impl);
    const args = { api: "booking", path: "/reviews", description: "The reviews of one hotel." };

    const preview = await call("request_endpoint", args);
    expect(preview.text).toContain("GET /photos is being built for this API right now and 1 more ahead of it");
    expect(preview.text).toContain("would wait in line and start on its own");

    const queued = await call("request_endpoint", { ...args, confirm: true });
    expect(queued.isError).toBe(false);
    expect(queued.text).toContain("Request accepted: GET /reviews on booking. It waits in line behind GET /photos");
    expect(queued.text).toContain("request_id: req-10");

    const full = await call("request_endpoint", args);
    expect(full.text).toContain("the line of requests for this API is full");
  });

  it("explains a full line, a taken path and a missing permission", async () => {
    const answers: Response[] = [
      Response.json(
        { error: "extension_in_progress", message: "3 endpoints are already being built or waiting for this API. Ask for yours once one of them has landed.", path: "/photos", requestId: "req-3" },
        { status: 409 },
      ),
      Response.json(
        { error: "endpoint_exists", message: "GET /search already exists and endpoints do not change once they are live. Ask for a revision instead." },
        { status: 409 },
      ),
      Response.json({ error: "missing_scope", scope: "requests:write", message: "no" }, { status: 403 }),
    ];
    const fetch = backend({ [ASK]: () => answers.shift()! });
    const call = await connect(fetch.impl);
    const args = { api: "booking", path: "/reviews", description: "The reviews of one hotel.", confirm: true };

    const busy = await call("request_endpoint", args);
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain("It is your own request: req-3.");
    expect(busy.text).toContain("An API holds 3 requests at a time");

    const taken = await call("request_endpoint", args);
    expect(taken.text).toContain("already exists");

    const scope = await call("request_endpoint", args);
    expect(scope.text).toContain("only calls data APIs");
    expect(scope.text).toContain("/dashboard/keys");
  });

  it("needs a path or a change, and a real endpoint to change", async () => {
    const call = await connect(backend({}).impl);
    const neither = await call("request_endpoint", { api: "booking", description: "Reviews." });
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain("Pass `path`");
    const unknown = await call("request_endpoint", { api: "booking", change: "/nope", description: "Reviews." });
    expect(unknown.text).toContain('booking has no endpoint "/nope" to change');
  });

  it("refuses the shared demo key before calling anything", async () => {
    const fetch = backend({});
    const call = await connect(fetch.impl, {});
    const res = await call("request_endpoint", { api: "booking", path: "/reviews", description: "Reviews." });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("needs your own maviapi API key");
    expect(fetch.calls.some((c) => c.url.pathname.startsWith("/v1/me/"))).toBe(false);
  });
});

describe("get_build_status with your own key", () => {
  it("shows the phase, endpoints and what the build said, then waits for the next change", async () => {
    const seen: Array<{ wait: string | null; state: string | null }> = [];
    const answers = [STATUS, READY];
    const fetch = backend({
      "GET /v1/me/requests/req-9/status": (url) => {
        seen.push({ wait: url.searchParams.get("wait"), state: url.searchParams.get("state") });
        return Response.json(answers.shift() ?? READY);
      },
    });
    const call = await connect(fetch.impl);

    const first = await call("get_build_status", { request_id: "req-9", wait_seconds: 40 });
    expect(first.text).toContain("Request req-9 (new endpoint GET /reviews on booking): building.");
    expect(first.text).toContain("- GET /reviews: building");
    expect(first.text).toContain("- Reading the reviews page.");
    expect(first.text).toContain("Still working");

    const second = await call("get_build_status", { request_id: "req-9", wait_seconds: 40 });
    expect(second.text).toContain(": ready.");
    expect(second.text).toContain("- GET /reviews: ready (5 of 5 pages, 9 fields, 320 ms). Parameters: id=42");
    expect(second.text).toContain("call_draft");
    expect(second.text).toContain("publish_request");

    // The first look does not wait; the second passes the state it saw.
    expect(seen).toEqual([
      { wait: null, state: null },
      { wait: "30", state: "aaaa1111" },
    ]);

    // A settled request is answered at once, however long the caller would wait.
    await call("get_build_status", { request_id: "req-9", wait_seconds: 40 });
    expect(seen[2]).toEqual({ wait: null, state: null });
  });

  it("falls back to the plain build status where the request routes are not open to keys", async () => {
    const fetch = backend({
      "GET /v1/me/requests/req-1/status": () => Response.json({ error: "Unauthorized" }, { status: 401 }),
      "GET /v1/requests/req-1": () =>
        Response.json({ id: "req-1", status: "building", domain: "news.ycombinator.com", slug: null, error: null, progress: [] }),
    });
    const call = await connect(fetch.impl);
    const res = await call("get_build_status", { request_id: "req-1" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Build req-1 for news.ycombinator.com: building.");
  });

  it("falls back for a key without request permissions too", async () => {
    const fetch = backend({
      "GET /v1/me/requests/req-1/status": () =>
        Response.json({ error: "missing_scope", scope: "requests:write" }, { status: 403 }),
      "GET /v1/requests/req-1": () =>
        Response.json({ id: "req-1", status: "queued", domain: "example.com", slug: null, error: null, progress: [] }),
    });
    const call = await connect(fetch.impl);
    const res = await call("get_build_status", { request_id: "req-1", wait_seconds: 30 });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Build req-1 for example.com: queued.");
  });

  it("says a published request is live and where", async () => {
    const fetch = backend({
      "GET /v1/me/requests/req-9/status": () =>
        Response.json({
          ...READY,
          phase: "published",
          live: { version: "v3.0", baseUrl: "https://api.maviapi.com/v1/sites/booking" },
        }),
    });
    const call = await connect(fetch.impl);
    const res = await call("get_build_status", { request_id: "req-9" });
    expect(res.text).toContain("Live as v3.0 at https://api.maviapi.com/v1/sites/booking.");
  });
});

describe("call_draft", () => {
  it("calls a ready endpoint of the draft with its parameters", async () => {
    const fetch = backend({
      "GET /v1/me/requests/req-9/status": () => Response.json(READY),
      "GET /v1/drafts/drf_abc/reviews": () => Response.json({ data: { reviews: [{ rating: 9 }] } }),
    });
    const call = await connect(fetch.impl);
    const res = await call("call_draft", { request_id: "req-9", endpoint: "reviews", params: { id: 7 } });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('"rating":9');
    const sent = fetch.calls.find((c) => c.url.pathname === "/v1/drafts/drf_abc/reviews")!;
    expect(sent.url.searchParams.get("id")).toBe("7");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("refuses an endpoint that is not ready or not in the request", async () => {
    const fetch = backend({ "GET /v1/me/requests/req-9/status": () => Response.json(STATUS) });
    const call = await connect(fetch.impl);
    const building = await call("call_draft", { request_id: "req-9", endpoint: "/reviews" });
    expect(building.isError).toBe(true);
    expect(building.text).toContain("GET /reviews is building");
    const unknown = await call("call_draft", { request_id: "req-9", endpoint: "/photos" });
    expect(unknown.text).toContain('no endpoint "/photos". It has: /reviews.');
  });
});

describe("publish_request / cancel_request / send_request_message", () => {
  it("publishes and says how to confirm", async () => {
    const fetch = backend({
      "POST /v1/me/requests/req-9/publish": () => Response.json({ ok: true, version: "v3.0" }, { status: 202 }),
    });
    const call = await connect(fetch.impl);
    const res = await call("publish_request", { request_id: "req-9" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Publishing v3.0.");
    expect(JSON.parse(fetch.calls.at(-1)!.body!)).toEqual({});
  });

  it("explains a key that may not publish, and a refusal in the build's own words", async () => {
    const answers = [
      Response.json({ error: "missing_scope", scope: "requests:publish" }, { status: 403 }),
      Response.json({ error: "build_not_settled" }, { status: 409 }),
    ];
    const fetch = backend({
      "POST /v1/me/requests/req-9/publish": () => answers.shift()!,
      "GET /v1/me/requests/req-9/status": () =>
        Response.json({
          ...STATUS,
          messages: [{ kind: "agent", text: "Some endpoints are still being tested. Publish once every check has finished." }],
        }),
    });
    const call = await connect(fetch.impl);
    const scope = await call("publish_request", { request_id: "req-9" });
    expect(scope.isError).toBe(true);
    expect(scope.text).toContain("may not publish (it has no requests:publish permission)");
    expect(scope.text).toContain("/dashboard/requests");

    const early = await call("publish_request", { request_id: "req-9" });
    expect(early.isError).toBe(true);
    expect(early.text).toContain("Not published (build_not_settled). Some endpoints are still being tested.");
  });

  it("cancels a running build", async () => {
    const fetch = backend({
      "POST /v1/me/requests/req-9/cancel": () =>
        Response.json({ ...STATUS, phase: "failed", state: "cccc3333", error: "This build was cancelled." }),
    });
    const call = await connect(fetch.impl);
    const res = await call("cancel_request", { request_id: "req-9" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Cancelled.");
    expect(res.text).toContain("The build stopped: This build was cancelled.");
  });

  it("relays a message and the build's answer", async () => {
    const fetch = backend({
      "POST /v1/me/requests/req-9/messages": () => Response.json({ ok: true }),
      "GET /v1/me/requests/req-9/status": () =>
        Response.json({ ...STATUS, messages: [{ kind: "agent", text: "Noted, I will add the review date." }] }),
    });
    const call = await connect(fetch.impl);
    const res = await call("send_request_message", { request_id: "req-9", message: "also return the review date" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("The build answered: Noted, I will add the review date.");
    const sent = fetch.calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(sent.body!)).toEqual({ text: "also return the review date" });
  });
});

describe("list_requests / get_key_info / get_changelog", () => {
  it("lists requests and keeps a finished build apart from a public one", async () => {
    const fetch = backend({
      "GET /v1/me/requests": (url) => {
        expect(url.searchParams.get("slug")).toBe("booking");
        return Response.json([
          { id: "req-9", slug: "booking", domain: "www.booking.com", status: "published", live: true, kind: "extend", extension: { path: "/reviews" }, createdAt: "2026-11-12T10:00:00.000Z" },
          { id: "req-8", slug: "hn", domain: "news.ycombinator.com", status: "published", live: false, kind: "build", extension: null, createdAt: "2026-11-11T10:00:00.000Z" },
        ]);
      },
    });
    const call = await connect(fetch.impl);
    const res = await call("list_requests", { api: "booking.com" });
    expect(res.text).toContain("- req-9: GET /reviews on booking: built, API is public (2026-11-12)");
    expect(res.text).toContain("- req-8: API for news.ycombinator.com (hn): built, not published (2026-11-11)");
  });

  it("says what the key may do", async () => {
    const fetch = backend({
      "GET /v1/me/key": () =>
        Response.json({
          key: { name: "agent", prefix: "mvk_live_ab12…", env: "live", scopes: ["requests:write"] },
          plan: { id: "trial", name: "Trial" },
          credits: { used: 10, included: 5000, remaining: 4990, payAsYouGo: false, periodEnd: "2026-12-01T00:00:00.000Z" },
          limits: { callsPerMinute: 600, callsPerDay: null, newApiBuilds: { perDay: 10 }, endpointRequests: { perHour: 2, perDay: 5 } },
          pins: [{ slug: "booking", version: 2 }],
        }),
    });
    const call = await connect(fetch.impl);
    const res = await call("get_key_info");
    expect(res.text).toContain("It can call every API, start and manage builds.");
    expect(res.text).toContain("It cannot publish (no requests:publish permission)");
    expect(res.text).toContain("Credits: 4990 of 5000 left until 2026-12-01.");
    expect(res.text).toContain("Endpoint requests: 2 an hour, 5 a day.");
    expect(res.text).toContain("Pinned versions: booking on v2.");
  });

  it("lists versions with what changed, also on the demo key", async () => {
    const fetch = backend({
      "GET /v1/apis/booking/changelog": () =>
        Response.json({
          api: { slug: "booking", name: "Booking.com" },
          entries: [
            { version: 3, state: "active", compat: "compatible", date: "2026-11-12T10:00:00.000Z", hotfix_of: null, diff: { added_endpoints: ["/reviews"], removed_endpoints: [], removed_fields: [], retyped_fields: [], new_required_params: [] } },
            { version: 2, state: "superseded", compat: "breaking", date: "2026-10-01T10:00:00.000Z", hotfix_of: null, diff: { added_endpoints: [], removed_endpoints: [], removed_fields: [{ endpoint: "/search", path: "data.hotels[].stars" }], retyped_fields: [], new_required_params: [] } },
          ],
        }),
    });
    const call = await connect(fetch.impl, {});
    const res = await call("get_changelog", { api: "booking" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("- v3 (live, 2026-11-12): added /reviews");
    expect(res.text).toContain("- v2 (superseded, breaking, 2026-10-01): fields removed: /search data.hotels[].stars");
  });
});

describe("get_api and call_api extras", () => {
  it("flags an endpoint that is down and lists what is being built", async () => {
    const fetch = backend({
      "GET /v1/apis/booking/health": () =>
        Response.json({
          slug: "booking",
          status: "partial_outage",
          endpoints: [
            { method: "GET", path: "/search", status: "down" },
            { method: "GET", path: "/hotel/{country}/{slug}", status: "operational" },
          ],
        }),
      "GET /v1/apis/booking/endpoint-requests": () => Response.json({ building: [{ path: "/reviews", of: null, status: "building" }] }),
    });
    const call = await connect(fetch.impl);
    const res = await call("get_api", { api: "booking" });
    expect(res.text).toContain("Health: partial_outage");
    expect(res.text).toContain("## search: GET /search\nStatus: down right now.");
    expect(res.text).not.toContain("Status: operational");
    expect(res.text).toContain("Being built right now: GET /reviews.");
    expect(res.text).toContain("request_endpoint adds an endpoint");
  });

  it("calls a chosen version with the version header", async () => {
    const fetch = backend({});
    const call = await connect(fetch.impl);
    await call("call_api", { api: "booking", endpoint: "search", params: { location: "Istanbul" }, version: 2 });
    const sent = fetch.calls.find((c) => c.url.pathname === "/v1/sites/booking/search")!;
    expect(sent.headers.get("x-maviapi-version")).toBe("2");
    const bad = await call("call_api", { api: "booking", endpoint: "search", params: { location: "Istanbul" }, version: "latest" });
    expect(bad.isError).toBe(true);
  });
});

describe("helpers", () => {
  it("reads an endpoint path the way callers write it", () => {
    expect(shortPath("/v1/sites/booking/reviews", "booking")).toBe("/reviews");
    expect(shortPath("reviews", "booking")).toBe("/reviews");
    expect(shortPath("/reviews", null)).toBe("/reviews");
  });

  it("describes a version's changes, or nothing", () => {
    expect(describeDiff(null)).toBe("");
    expect(
      describeDiff({
        added_endpoints: ["/a"],
        removed_endpoints: ["/b"],
        removed_fields: [],
        retyped_fields: [{ endpoint: "/c", path: "data.x", from: "string", to: "number" }],
        new_required_params: [{ endpoint: "/d", param: "id" }],
      }),
    ).toBe("added /a; removed /b; fields changed type: /c data.x (string to number); new required parameters: /d id");
  });
});

describe("report_endpoint_issue", () => {
  const REPORT = "POST /v1/me/apis/booking/endpoint-reports";
  const LIST = "GET /v1/me/endpoint-reports";
  const CONFIRMED = {
    id: "er_1",
    slug: "booking",
    path: "/search",
    status: "confirmed",
    message: "We reproduced it. A repair is under way: the endpoint keeps its path and its contract, so nothing changes for you except the answer.",
    found: "The endpoint returns its first page for every page.",
  };

  it("reports the endpoint with the failing call and says what maviapi saw", async () => {
    const fetch = backend({ [REPORT]: () => Response.json(CONFIRMED, { status: 201 }) });
    const call = await connect(fetch.impl);
    const res = await call("report_endpoint_issue", {
      api: "booking",
      endpoint: "search",
      description: "offset=50 returns the same stays as offset=0.",
      params: { location: "Istanbul", offset: 50 },
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Report er_1 on GET /search of booking: We reproduced it.");
    expect(res.text).toContain("What maviapi saw: The endpoint returns its first page for every page.");
    expect(res.text).toContain("the endpoint keeps its path");

    const sent = JSON.parse(fetch.calls.find((c) => c.method === "POST")!.body!);
    expect(sent).toEqual({
      path: "/search",
      description: "offset=50 returns the same stays as offset=0.",
      params: { location: "Istanbul", offset: 50 },
    });
  });

  it("points at a changed version when the report was not reproduced", async () => {
    const fetch = backend({
      [REPORT]: () =>
        Response.json(
          { ...CONFIRMED, status: "received", message: "We replayed the call and could not reproduce a fault automatically, so a person on the team will read your report.", found: null },
          { status: 201 },
        ),
    });
    const call = await connect(fetch.impl);
    const res = await call("report_endpoint_issue", {
      api: "booking",
      endpoint: "/search",
      description: "The prices look like they are in the wrong currency.",
    });
    expect(res.text).toContain("a person on the team will read your report");
    expect(res.text).toContain("request_endpoint with `change`");
    expect(JSON.parse(fetch.calls.find((c) => c.method === "POST")!.body!).params).toBeUndefined();
  });

  it("refuses an endpoint the API does not have, before calling maviapi", async () => {
    const fetch = backend({ [REPORT]: () => Response.json(CONFIRMED, { status: 201 }) });
    const call = await connect(fetch.impl);
    const res = await call("report_endpoint_issue", {
      api: "booking",
      endpoint: "/reviews",
      description: "It returns nothing at all for any hotel.",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('booking has no endpoint "/reviews"');
    expect(fetch.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains a repeat and a missing permission", async () => {
    const answers: Response[] = [
      Response.json(
        { error: "already_reported", message: "You reported this endpoint in the last day. That report still stands.", reportId: "er_1" },
        { status: 409 },
      ),
      Response.json({ error: "missing_scope", scope: "requests:write", message: "no" }, { status: 403 }),
    ];
    const fetch = backend({ [REPORT]: () => answers.shift()! });
    const call = await connect(fetch.impl);
    const args = { api: "booking", endpoint: "search", description: "offset=50 returns the same stays as offset=0." };

    const again = await call("report_endpoint_issue", args);
    expect(again.isError).toBe(true);
    expect(again.text).toContain("That report still stands.");
    expect(again.text).toContain("with no arguments");

    const denied = await call("report_endpoint_issue", args);
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("requests:write");
  });

  it("lists the reports made with the key when called with no arguments", async () => {
    const fetch = backend({
      [LIST]: () => Response.json({ reports: [{ ...CONFIRMED, status: "fixed", message: "This was repaired. The endpoint answers correctly again." }] }),
    });
    const call = await connect(fetch.impl);
    const res = await call("report_endpoint_issue");
    expect(res.text).toContain("er_1  booking GET /search  fixed");
    expect(res.text).toContain("This was repaired.");

    const none = await connect(backend({ [LIST]: () => Response.json({ reports: [] }) }).impl);
    expect((await none("report_endpoint_issue")).text).toContain("No endpoint has been reported");
  });
});
