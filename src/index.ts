#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);
await server.connect(new StdioServerTransport());

// stdout carries the protocol, so diagnostics go to stderr.
console.error(
  config.usingPlaygroundKey
    ? "maviapi MCP server running on stdio with the shared demo key. Set MAVIAPI_API_KEY for a higher limit: https://maviapi.com/sign-up"
    : "maviapi MCP server running on stdio.",
);
