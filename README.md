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

The MCP server is **read-only** — it exposes only the read tools plus a GET-only `get` escape hatch. There is no arbitrary-request tool, so an agent driving it can never modify Holdsport data.

Credentials are passed on **every tool call**: each tool takes `username` and `password` arguments (plus optional `team_id` and `base_url`), and a fresh client is built per call. The server itself takes no arguments and holds no credentials — the MCP host supplies them with each invocation.

```sh
bun bin/holdsport-mcp
```

### Register with Claude Cowork

```json
{
  "mcpServers": {
    "holdsport": {
      "command": "bun",
      "args": [
        "/Users/troelskn/Projects/claude-holdsport-mcp-server/bin/holdsport-mcp"
      ]
    }
  }
}
```

The host (or the model) provides `username`/`password` with each tool call.

### Tools

`teams`, `members`, `member`, `roster`, `notes`, `activities`, `activity`, `attendees`, `headcount`, `tasks`, `user`, `profiles`, and `get` (raw GET). Every tool requires `username` and `password`; team-scoped tools also need a `team_id`.
