import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MaviapiClient } from "./client.js";
import { VERSION, type Config } from "./config.js";
import { Toolset } from "./tools.js";

const INSTRUCTIONS = `maviapi gives you live, structured JSON from websites that have no official API (travel, e-commerce, news, events, finance and more).
Workflow: search_apis to find an API for a site or topic, get_api to read its endpoints and parameters, then call_api to fetch data.
If no API covers the site you need, create_api builds one (about half an hour; follow it with get_build_status).`;

/**
 * The tool list is computed at request time (MAVIAPI_TOOLS adds one typed tool
 * per endpoint, read from the live catalog), so the handlers are registered on
 * the underlying protocol server rather than through McpServer.registerTool,
 * which wants a static zod schema per tool.
 */
export function createServer(config: Config, fetchImpl?: typeof fetch): McpServer {
  const toolset = new Toolset(new MaviapiClient(config, fetchImpl));
  const mcp = new McpServer(
    { name: "maviapi", title: "maviapi", version: VERSION, websiteUrl: "https://maviapi.com" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await toolset.list() }));
  mcp.server.setRequestHandler(CallToolRequestSchema, (request) =>
    toolset.call(request.params.name, request.params.arguments ?? {}),
  );
  return mcp;
}
