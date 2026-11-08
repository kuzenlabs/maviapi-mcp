/**
 * Smoke test against the real maviapi API, through the built binary over
 * stdio, exactly as an MCP client runs it. Opt in with `pnpm test:live`
 * (after `pnpm build`); it spends a couple of requests on the demo key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const live = process.env.MAVIAPI_LIVE === "1";

describe.runIf(live)("live maviapi", () => {
  const client = new Client({ name: "live-test", version: "0.0.0" });

  beforeAll(async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    await client.connect(
      new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...env, MAVIAPI_TOOLS: "selcoin" } }),
    );
  });
  afterAll(() => client.close());

  const text = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    return { text: first?.type === "text" ? first.text : "", isError: result.isError === true };
  };

  it("lists the catalog and the typed selcoin tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("selcoin_metals");
    expect((await text("search_apis", { query: "booking.com" })).text).toContain("- booking:");
  });

  it("describes an API from the live schemas", async () => {
    const res = await text("get_api", { api: "hurriyet" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("## latest: GET /latest");
  });

  it("fetches live data", { timeout: 120_000 }, async () => {
    const res = await text("call_api", { api: "quotes-toscrape", endpoint: "quotes", params: { limit: 2 } });
    expect(res.isError, res.text).toBe(false);
    expect(JSON.parse(res.text.split("\n\n(")[0]!).data.quotes).toHaveLength(2);
  });
});
