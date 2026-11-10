# maviapi MCP server

Give Claude, Cursor, or any MCP client **live, structured JSON from websites that have no API**: Booking.com, Airbnb, Tripadvisor, Kiwi.com, Trainline, Hepsiburada, Yemeksepeti and more, plus any site you ask for.

```
You:    Find me a 3-night Airbnb in Lisbon next month under €120 a night.
Claude: → search_apis "airbnb" → get_api "airbnb" → call_api airbnb/search {location: "Lisbon", …}
        Here are the 5 best-rated options under €120…
```

Agents are bad at the web. Browsing is slow, burns tokens on raw HTML, and stalls on bot protection; hand-written scrapers break the next time the site changes its layout. [maviapi](https://maviapi.com) turns a website into a hosted, schema-first JSON API, and **monitors and repairs it when the site changes**, so the endpoint your agent depends on keeps answering. This server puts those APIs one tool call away.

**Works with no setup.** Out of the box it uses maviapi's shared demo key: 30 requests a minute and 300 a day per network, plus 3 free API builds per 30 days. [Create a free key](https://maviapi.com/sign-up?utm_source=github&utm_medium=readme&utm_campaign=mcp) for more.

**Missing a site? Your agent can have it built.** `create_api` hands maviapi's build agent a URL and a description of the data you want; about half an hour later the new API is live and callable from the same session.

## Install

### Claude Code

Install it as a plugin from this repo's marketplace:

```
/plugin marketplace add kuzenlabs/maviapi-mcp
/plugin install maviapi@maviapi
```

The plugin reads `MAVIAPI_API_KEY` (and `MAVIAPI_TOOLS`) from your environment, so export your key before starting Claude Code to use it instead of the demo key.

Or add the server directly. Quote the package name so zsh doesn't offer to "correct" the `@` scope away:

```bash
claude mcp add maviapi -- npx -y '@maviapi/mcp'

# with your own key
claude mcp add maviapi -e MAVIAPI_API_KEY=mvk_live_... -- npx -y '@maviapi/mcp'
```

### Claude Desktop, Cursor, Windsurf, and others

Add this to the client's MCP config (`claude_desktop_config.json`, `~/.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "maviapi": {
      "command": "npx",
      "args": ["-y", "@maviapi/mcp"],
      "env": { "MAVIAPI_API_KEY": "mvk_live_..." }
    }
  }
}
```

Leave out `env` to try it with the demo key.

### VS Code

`.vscode/mcp.json`:

```json
{
  "inputs": [{ "type": "promptString", "id": "maviapi-key", "description": "maviapi API key", "password": true }],
  "servers": {
    "maviapi": {
      "command": "npx",
      "args": ["-y", "@maviapi/mcp"],
      "env": { "MAVIAPI_API_KEY": "${input:maviapi-key}" }
    }
  }
}
```

## Tools

| Tool | What it does |
|------|--------------|
| `search_apis` | Find an API for a website or topic ("flights", "turkish news", "booking.com"). Empty query lists the whole catalog. |
| `get_api` | An API's endpoints, their parameters, and the fields each one returns. |
| `call_api` | Call an endpoint and get live JSON back. List endpoints return 10 results unless you pass `limit`. |
| `create_api` | No API for the site you need? Starts a build from a URL and a plain-language description, and returns a `request_id`. |
| `get_build_status` | Follows a build to `published` (then `get_api` and `call_api` work on it) or `failed`. Builds take about half an hour. |

A handful of generic tools keeps the agent's context small however large the catalog grows. If you rely on a few APIs, `MAVIAPI_TOOLS` also exposes each of their endpoints as its own typed tool, with a full input schema:

```bash
claude mcp add maviapi -e MAVIAPI_TOOLS=booking,airbnb,kiwi -- npx -y '@maviapi/mcp'
# adds booking_search, booking_explore, airbnb_listing_by_id, kiwi_search, …
```

## What you can ask

- "Cheapest flights from Istanbul to Berlin any day in the first week of December?" (Kiwi.com, FlightList)
- "Train or plane from London to Paris on Friday: which is cheaper?" (Trainline, Kiwi.com)
- "Top-rated restaurants in Istanbul on Tripadvisor, with review counts."
- "Bu hafta sonu İstanbul'da hangi konserler var?" (Bubilet)
- "What are gold and silver trading at right now?" (Selcoin)
- "What does 'serendipity' mean in Turkish? Give me every sense." (Sesli Sözlük)

`search_apis` with no query lists everything currently in the catalog. And for a site that is not there yet:

- "Build me an API for news.ycombinator.com with the front page stories, points and comment counts, then show me today's top 5."

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAVIAPI_API_KEY` | shared demo key | Your key from the [maviapi dashboard](https://maviapi.com/dashboard). |
| `MAVIAPI_TOOLS` | none | Comma-separated API slugs to expose as typed per-endpoint tools, or `all`. |
| `MAVIAPI_BASE_URL` | `https://api.maviapi.com` | Point at another maviapi deployment. |

## Pricing

Each successful call uses one credit; failed calls are free. Building an API is free on any plan, within the daily build limit (10 a day per account with your own key). New accounts start with a 7-day trial of 5,000 credits, no card required. Plans are on [maviapi.com/pricing](https://maviapi.com/pricing?utm_source=github&utm_medium=readme&utm_campaign=mcp).

## Development

```bash
pnpm install
pnpm test          # unit and protocol tests, offline
pnpm build
pnpm test:live     # smoke test of the built server against the real API
pnpm inspect       # open the MCP Inspector against the built server
```

## License

MIT
