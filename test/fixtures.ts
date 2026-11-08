import type { ApiSummary, RawEndpoint } from "../src/catalog.js";

export const APIS: ApiSummary[] = [
  {
    id: "10",
    slug: "booking",
    name: "Booking.com",
    description: "Search Booking.com accommodations by location and stay dates, with pricing and review scores.",
    target_url: "https://www.booking.com",
  },
  {
    id: "11",
    slug: "airbnb",
    name: "Airbnb",
    description: "Search Airbnb short-term rental listings by location and dates.",
    target_url: "https://www.airbnb.com",
  },
  {
    id: "12",
    slug: "hurriyet",
    name: "Hürriyet",
    description: "Latest Turkish news from Hürriyet across sections.",
    target_url: "https://www.hurriyet.com.tr",
  },
];

export const ENDPOINTS: Record<string, RawEndpoint[]> = {
  booking: [
    {
      slug: "search",
      path: "/search",
      method: "GET",
      description: "Search stays in a location.",
      versions: [
        {
          version: "1.0.0",
          input_schema: { type: "object", properties: { location: { type: "string" } } },
        },
        {
          version: "2.0.0",
          input_schema: {
            type: "object",
            properties: {
              location: { type: "string", description: "City or region", example: "Istanbul" },
              checkin: { type: "string", format: "date" },
              limit: { type: "integer", default: 50 },
              offset: { type: "integer", default: 0 },
              refresh: { type: "boolean", default: false },
            },
            required: ["location"],
          },
          output_schema: {
            type: "object",
            properties: {
              data: {
                type: "object",
                properties: {
                  count: { type: "integer" },
                  hotels: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { name: { type: "string" }, price: { type: "number" } },
                    },
                  },
                },
              },
              cached: { type: "boolean" },
            },
          },
        },
      ],
    },
    {
      slug: "hotel",
      path: "/hotel/{country}/{slug}",
      method: "GET",
      description: "One property's details.",
      versions: [
        {
          version: "2.0.0",
          input_schema: {
            type: "object",
            properties: { country: { type: "string" }, slug: { type: "string" }, checkin: { type: "string" } },
          },
        },
      ],
    },
  ],
  airbnb: [
    {
      slug: "listing/:id",
      path: "/listing/{id}",
      method: "GET",
      description: "One listing.",
      versions: [{ version: "1.0.0", input_schema: { type: "object", properties: { id: { type: "string" } } } }],
    },
  ],
  hurriyet: [
    {
      slug: "latest",
      path: "/latest",
      method: "GET",
      description: "Newest articles.",
      versions: [{ version: "1.0.0", input_schema: { type: "object", properties: { limit: { type: "integer" } } } }],
    },
  ],
};

export interface Recorded {
  url: URL;
  headers: Headers;
  method: string;
  body?: string;
}

/**
 * A fetch that serves the fixture catalog and records every call. `gateway`
 * answers /v1/sites/* requests; `other`, when it returns a response, answers
 * anything else first.
 */
export function fakeFetch(
  gateway: (url: URL) => Response = () => Response.json({ data: { ok: true } }, { headers: { "x-maviapi-version": "2" } }),
  other: (url: URL, init?: RequestInit) => Response | undefined = () => undefined,
) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({
      url,
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const answered = other(url, init);
    if (answered) return answered;
    if (url.pathname === "/v1/apis") return Response.json(APIS);
    const endpoints = url.pathname.match(/^\/v1\/apis\/([^/]+)\/endpoints$/);
    if (endpoints) {
      const rows = ENDPOINTS[decodeURIComponent(endpoints[1]!)];
      return rows ? Response.json(rows) : Response.json({ error: "unknown_site" }, { status: 404 });
    }
    if (url.pathname.startsWith("/v1/sites/")) return gateway(url);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}
