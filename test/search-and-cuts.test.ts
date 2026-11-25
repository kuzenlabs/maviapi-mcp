import { describe, expect, it } from "vitest";
import { outlineOutput, searchApis, type ApiSummary, type JsonSchema } from "../src/catalog.js";
import { fitAnswer } from "../src/result.js";

const api = (slug: string, name: string, description: string, target_url: string): ApiSummary => ({
  id: slug,
  slug,
  name,
  description,
  target_url,
});

/** A slice of the live catalog, with the descriptions that used to match "time out". */
const CATALOG = [
  api("selcoin", "Selcoin", "Real-time market data from Selcoin: crypto spot prices, forex, precious metals.", "https://selcoin.io"),
  api("hurriyet", "Hürriyet", "Latest Turkish news from Hürriyet, a feed throughout the day without paywalls.", "https://www.hurriyet.com.tr"),
  api("tripadvisor", "Tripadvisor", "Trip-planning data: attractions, restaurants and hotels by city.", "https://www.tripadvisor.com"),
  api("booking", "Booking.com", "Search Booking.com accommodations by location and stay dates.", "https://www.booking.com"),
  api("thetrainline", "Trainline", "Train ticket fares and departure times between any two stations.", "https://www.thetrainline.com"),
  api("maps-google", "Google Maps", "Structured data from maps.google.com.", "https://maps.google.com/"),
];

const slugs = (query: string) => searchApis(CATALOG, query).map((a) => a.slug);

describe("searchApis (maviapi#1072)", () => {
  it("returns nothing for a query no API is about", () => {
    expect(slugs("time out")).toEqual([]);
    expect(slugs("timeout")).toEqual([]);
  });

  it("matches whole words, not parts of words", () => {
    // "out" is inside "without" and "throughout", "time" inside "Real-time" only as its own word.
    expect(slugs("out")).toEqual([]);
  });

  it("still finds an API by slug, name, site or topic", () => {
    expect(slugs("booking.com")[0]).toBe("booking");
    expect(slugs("booking")[0]).toBe("booking");
    expect(slugs("trainline")).toEqual(["thetrainline"]);
    expect(slugs("google maps")[0]).toBe("maps-google");
    expect(slugs("hotels")).toEqual(["tripadvisor"]);
    expect(slugs("turkish news")).toEqual(["hurriyet"]);
    expect(slugs("hotels data api")).toEqual(["tripadvisor"]);
  });

  it("lists everything for an empty query", () => {
    expect(slugs("")).toHaveLength(CATALOG.length);
  });
});

describe("outlineOutput", () => {
  it("lists a few dozen fields in full, where it used to stop at 25", () => {
    const fields = Object.fromEntries(
      ["name", "slug", "url", "event_id", "venue", "dates", "start_date", "end_date", "session_count", "price",
        "original_price", "currency", "is_free", "sold_out", "image"].map((k) => [k, { type: "string" }]),
    );
    const schema: JsonSchema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            total: { type: "integer" },
            events: { type: "array", items: { type: "object", properties: { ...fields, extra1: { type: "string" }, extra2: { type: "string" }, extra3: { type: "string" }, extra4: { type: "string" }, extra5: { type: "string" }, extra6: { type: "string" }, extra7: { type: "string" }, extra8: { type: "string" }, extra9: { type: "string" }, extra10: { type: "string" }, extra11: { type: "string" } } } },
          },
        },
      },
    };
    const lines = outlineOutput(schema);
    expect(lines).toHaveLength(27);
    expect(lines).toContain("data.events[].sold_out: string");
    expect(lines).toContain("data.events[].extra11: string");
  });

  it("says how many fields it left out past its cap", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, { type: "string" }])),
    };
    const lines = outlineOutput(schema, 10);
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("… and 2 more fields");
  });
});

describe("fitAnswer", () => {
  it("passes a short answer through as one text block", () => {
    const out = fitAnswer({ data: [1, 2, 3] }, { max: 1000 });
    expect(out.content).toEqual([{ type: "text", text: '{"data":[1,2,3]}' }]);
    expect(out._meta).toBeUndefined();
  });

  it("cuts a top-level list at whole rows", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ i, pad: "y".repeat(50) }));
    const out = fitAnswer(rows, { max: 1000, asked: 50 });
    const kept = JSON.parse((out.content[0] as { text: string }).text) as unknown[];
    const flag = JSON.parse((out.content[1] as { text: string }).text);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(50);
    expect(flag).toMatchObject({ truncated: true, rows_returned: kept.length, rows_in_answer: 50, rows_asked: 50, max_chars: 1000 });
  });

  it("cuts text it cannot split into rows at the character limit, and says so", () => {
    const out = fitAnswer("z".repeat(3000), { max: 1000 });
    expect((out.content[0] as { text: string }).text).toHaveLength(1000);
    const flag = JSON.parse((out.content[1] as { text: string }).text);
    expect(flag.truncated).toBe(true);
    expect(flag.rows_returned).toBeUndefined();
    expect(flag.note).toContain("does not cut answers");
  });
});
