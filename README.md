# holdsport

A tiny [Bun](https://bun.sh) toolkit for the [Holdsport API](https://github.com/Holdsport/holdsport-api), shipping two binaries that share one data layer:

- **`bin/holdsport`** — the CLI (rosters, schedule, headcounts) for the terminal.
- **`bin/holdsport-mcp`** — a **read-only** [MCP](https://modelcontextprotocol.io) server exposing the same read commands as tools, for use from Claude Cowork (or any MCP host).

The shared API client + business logic lives in [`src/client.ts`](src/client.ts); CLI-only terminal rendering lives in [`src/render.ts`](src/render.ts).

## Setup

```sh
bun install
bun test     # unit tests (offline — network is mocked)
```

Holdsport uses HTTP Basic auth with your Holdsport login.

## CLI

Credentials come from the environment (Bun auto-loads `.env`):

```sh
# .env
HOLDSPORT_USERNAME=you@example.com
HOLDSPORT_PASSWORD=your-password
HOLDSPORT_TEAM_ID=37141      # default team for team-scoped commands
```

```sh
bun bin/holdsport help
bun bin/holdsport teams
bun bin/holdsport roster --players --csv
bun bin/holdsport activities 2026-06-01
bun bin/holdsport headcount <activity_id> --players --names
```

Team-scoped commands default to `HOLDSPORT_TEAM_ID`; override per call with `--team <id>`. Output is human-readable by default; add `--json` (the `roster` command also has `--csv`). The CLI keeps the full escape hatch, including the write-capable `request <METHOD> <path> [json]`.

## MCP server

Unlike the CLI, the MCP server takes credentials as **command-line flags** (so the host config can supply them) and is **read-only** — it exposes only the read tools plus a GET-only `get` escape hatch. There is no arbitrary-request tool, so an agent driving it can never modify Holdsport data.

```sh
bun bin/holdsport-mcp --username you@example.com --password secret --team-id 37141
```

Flags: `--username`, `--password`, `--team-id`, `--base-url` (each falls back to the matching `HOLDSPORT_*` env var if omitted). Missing credentials are a start-up error.

### Register with Claude Cowork

Add to your MCP config, passing credentials as args:

```json
{
  "mcpServers": {
    "holdsport": {
      "command": "bun",
      "args": [
        "/Users/troelskn/Projects/claude-holdsport-mcp-server/bin/holdsport-mcp",
        "--username", "you@example.com",
        "--password", "your-password",
        "--team-id", "37141"
      ]
    }
  }
}
```

### Tools

`teams`, `members`, `member`, `roster`, `notes`, `activities`, `activity`, `attendees`, `headcount`, `tasks`, `user`, `profiles`, and `get` (raw GET). Team-scoped tools accept an optional `team_id` to override the configured default.
