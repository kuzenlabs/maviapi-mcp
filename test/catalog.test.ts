import { describe, expect, it } from "vitest";
import {
  MissingParamsError,
  buildQuery,
  describeParams,
  endpointName,
  fillPath,
  findApi,
  findEndpoint,
  hostOf,
  normalizeEndpoint,
  outlineOutput,
  pathParams,
  searchApis,
  sentences,
  toolName,
  truncate,
} from "../src/catalog.js";
import { APIS, ENDPOINTS } from "./fixtures.js";

const bookingSearch = normalizeEndpoint(ENDPOINTS.booking![0]!);
const bookingHotel = normalizeEndpoint(ENDPOINTS.booking![1]!);

describe("pathParams / fillPath", () => {
  it("reads both {name} and :name segments", () => {
    expect(pathParams("/hotel/{country}/{slug}")).toEqual(["country", "slug"]);
    expect(pathParams("/listing/:id")).toEqual(["id"]);
    expect(pathParams("/search")).toEqual([]);
  });

  it("substitutes and encodes path params, leaving the rest for the query", () => {
    expect(fillPath("/hotel/{country}/{slug}", { country: "tr", slug: "grand hotel", checkin: "2026-12-01" })).toEqual({
      path: "/hotel/tr/grand%20hotel",
      query: { checkin: "2026-12-01" },
    });
  });

  it("names every missing path param", () => {
    expect(() => fillPath("/hotel/{country}/{slug}", { country: "tr" })).toThrowError(MissingParamsError);
    expect(() => fillPath("/hotel/{country}/{slug}", {})).toThrowError("country, slug");
  });
});

describe("endpointName", () => {
  it("turns inconsistent catalog slugs into distinct, readable names", () => {
    expect(endpointName("search")).toBe("search");
    expect(endpointName("hotel")).toBe("hotel");
    expect(endpointName("listing/:id")).toBe("listing_by_id");
    expect(endpointName("templates/:id")).toBe("templates_by_id");
    expect(endpointName("transformations/:category/:name")).toBe("transformations_by_category_and_name");
    expect(endpointName("blog/categories")).toBe("blog-categories");
  });
});

describe("buildQuery", () => {
  it("encodes scalars, arrays and objects and skips nulls", () => {
    expect(buildQuery({ q: "çay bahçesi", tags: ["a", "b"], f: { x: 1 }, n: null, u: undefined, ok: true })).toBe(
      "?q=%C3%A7ay+bah%C3%A7esi&tags=a%2Cb&f=%7B%22x%22%3A1%7D&ok=true",
    );
    expect(buildQuery({})).toBe("");
  });
});

describe("normalizeEndpoint", () => {
  it("uses the newest schema doc and hides refresh", () => {
    expect(Object.keys(bookingSearch.inputSchema.properties)).toEqual(["location", "checkin", "limit", "offset"]);
    expect(bookingSearch.inputSchema.required).toEqual(["location"]);
  });

  it("folds OpenAPI examples into the description", () => {
    expect(bookingSearch.inputSchema.properties.location).toEqual({
      type: "string",
      description: 'City or region. Example: "Istanbul"',
    });
  });

  it("marks path params required even when the doc forgets to", () => {
    expect(bookingHotel.inputSchema.required).toEqual(["country", "slug"]);
    expect(bookingHotel.pathParams).toEqual(["country", "slug"]);
  });

  it("adds a path param the doc does not list at all", () => {
    const ep = normalizeEndpoint({ slug: "x", path: "/x/{id}", method: "get", description: null });
    expect(ep.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
    expect(ep.method).toBe("GET");
  });
});

describe("lookup", () => {
  it("finds APIs by slug, name, domain or URL", () => {
    expect(findApi(APIS, "booking")?.slug).toBe("booking");
    expect(findApi(APIS, "Airbnb")?.slug).toBe("airbnb");
    expect(findApi(APIS, "hurriyet.com.tr")?.slug).toBe("hurriyet");
    expect(findApi(APIS, "https://www.booking.com/hotel/tr/x.html")?.slug).toBe("booking");
    expect(findApi(APIS, "kayak")).toBeUndefined();
  });

  it("finds endpoints by slug or path", () => {
    const eps = [bookingSearch, bookingHotel];
    expect(findEndpoint(eps, "search")).toBe(bookingSearch);
    expect(findEndpoint(eps, "/search")).toBe(bookingSearch);
    expect(findEndpoint(eps, "hotel/{country}/{slug}")).toBe(bookingHotel);
    expect(findEndpoint(eps, "reviews")).toBeUndefined();
  });

  it("hostOf strips www and rejects non-domains", () => {
    expect(hostOf("https://www.Booking.com/x")).toBe("booking.com");
    expect(hostOf("airbnb.com")).toBe("airbnb.com");
    expect(hostOf("booking")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("searchApis", () => {
  it("lists everything for an empty query", () => {
    expect(searchApis(APIS, "")).toHaveLength(3);
  });

  it("matches plurals against singular descriptions", () => {
    expect(searchApis(APIS, "accommodation")[0]?.slug).toBe("booking");
    expect(searchApis(APIS, "listings")[0]?.slug).toBe("airbnb");
  });

  it("ranks by slug, host, name and description", () => {
    expect(searchApis(APIS, "rental listings").map((a) => a.slug)).toEqual(["airbnb"]);
    expect(searchApis(APIS, "turkish news")[0]?.slug).toBe("hurriyet");
    expect(searchApis(APIS, "booking.com")[0]?.slug).toBe("booking");
    expect(searchApis(APIS, "flights")).toEqual([]);
  });
});

describe("rendering", () => {
  it("flattens a response schema into field paths", () => {
    expect(outlineOutput(bookingSearch.outputSchema)).toEqual([
      "data.count: integer",
      "data.hotels[].name: string",
      "data.hotels[].price: number",
      "cached: boolean",
    ]);
    expect(outlineOutput(null)).toEqual([]);
  });

  it("caps the outline", () => {
    expect(outlineOutput(bookingSearch.outputSchema, 2)).toEqual(["data.count: integer", "data.hotels[].name: string", "…"]);
  });

  it("joins description fragments with exactly one period", () => {
    expect(sentences(["Alias: q.", "Example: 1"])).toBe("Alias: q. Example: 1");
    expect(sentences(["Count", "", "Default: 3"])).toBe("Count. Default: 3");
    expect(sentences([])).toBe("");
  });

  it("describes params with enums and defaults, required first", () => {
    const lines = describeParams({
      type: "object",
      properties: {
        top: { type: "integer", description: "How many", enum: [1, 2], default: 1 },
        q: { type: "string" },
      },
      required: ["q"],
    });
    expect(lines).toEqual(["- q (string, required)", "- top (integer): How many. One of: 1, 2. Default: 1"]);
  });

  it("builds valid tool names", () => {
    expect(toolName("quotes-toscrape", "author")).toBe("quotes-toscrape_author");
    expect(toolName("a", "b/c.d")).toBe("a_b_c_d");
    expect(toolName("x".repeat(60), "endpoint")).toHaveLength(64);
  });

  it("truncates with or without a note", () => {
    expect(truncate("abcdef", 10)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 4, "page it")).toBe("abcd\n…[truncated: page it]");
  });
});
