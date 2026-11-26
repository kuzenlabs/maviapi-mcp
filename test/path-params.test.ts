import { describe, expect, it } from "vitest";
import { MissingParamsError, endpointName, fillPath, findEndpoint, normalizeEndpoint, pathParams, slugName } from "../src/catalog.js";

/**
 * A path parameter is any `{param}`, also one glued to text in its segment
 * (`/events/{city}-v2`, live on bubilet since before the manifest gate refused
 * that shape). Leaving it in the URL answered 502 (#1074).
 */
describe("pathParams", () => {
  it("reads whole-segment, colon and glued parameters", () => {
    expect(pathParams("/hotel/{country}/{slug}")).toEqual(["country", "slug"]);
    expect(pathParams("/listing/:id")).toEqual(["id"]);
    expect(pathParams("/events/{city}-v2")).toEqual(["city"]);
    expect(pathParams("/a/{x}-{y}.json")).toEqual(["x", "y"]);
    expect(pathParams("/search")).toEqual([]);
  });
});

describe("fillPath", () => {
  it("fills a glued parameter and leaves the rest for the query", () => {
    expect(fillPath("/events/{city}-v2", { city: "istanbul", limit: 5 })).toEqual({
      path: "/events/istanbul-v2",
      query: { limit: 5 },
    });
    expect(fillPath("/hotel/{country}/{slug}", { country: "tr", slug: "a b" }).path).toBe("/hotel/tr/a%20b");
    expect(fillPath("/listing/:id", { id: 7 }).path).toBe("/listing/7");
  });

  it("names a missing glued parameter", () => {
    expect(() => fillPath("/events/{city}-v2", {})).toThrow(MissingParamsError);
  });

  it("names an endpoint by its path, never its slug (#1090)", () => {
    expect(endpointName("/events-v2/{city}")).toBe("events-v2_by_city");
    expect(endpointName("/events/{city}-v2")).toBe("events-city-v2_by_city");
    expect(endpointName("/listing/:id")).toBe("listing_by_id");
    expect(endpointName("/search", "POST")).toBe("post-search");
  });

  it("keeps the slug-derived names older clients saved", () => {
    expect(slugName("events-v2")).toBe("events-v2");
    expect(slugName("listing/:id")).toBe("listing_by_id");
  });

  it("resolves an endpoint by path name, path, slug or old name", () => {
    const eps = [
      normalizeEndpoint({ slug: "events-v2", path: "/events/{city}-v2", method: "get", description: null }),
      normalizeEndpoint({ slug: "events-v2-city", path: "/events-v2/{city}", method: "get", description: null }),
    ];
    expect(findEndpoint(eps, "events-v2_by_city")?.path).toBe("/events-v2/{city}");
    expect(findEndpoint(eps, "/events-v2/{city}")?.path).toBe("/events-v2/{city}");
    expect(findEndpoint(eps, "events-v2")?.path).toBe("/events/{city}-v2");
    expect(findEndpoint(eps, "events-city-v2_by_city")?.path).toBe("/events/{city}-v2");
  });
});
