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
HOLDSPORT_USERNAME=your-login   # login username (not email/member no.), see below
HOLDSPORT_PASSWORD=your-password
HOLDSPORT_TEAM_ID=37141         # default team for team-scoped commands
```

One login username is used everywhere. REST Basic auth accepts your email, member number, or login username, but **chat/email only accepts the login username** — so set `HOLDSPORT_USERNAME` to that and it works for all commands.

```sh
bun bin/holdsport help
bun bin/holdsport teams
bun bin/holdsport roster --players --csv
bun bin/holdsport activities 2026-06-01
bun bin/holdsport headcount <activity_id> --players --names
bun bin/holdsport chats
bun bin/holdsport chat <room_id> --limit 20
bun bin/holdsport emails --limit 20
bun bin/holdsport email <email_id>
bun bin/holdsport gql-activities
bun bin/holdsport gql-activity <activity_id> --names
```

Team-scoped commands default to `HOLDSPORT_TEAM_ID`; override per call with `--team <id>`. Output is human-readable by default; add `--json` (the `roster` command also has `--csv`). The CLI is read-only and exposes only the named read commands — there is no raw-request escape hatch.

Credentials default to the environment but can be overridden per call with `--user <login>` / `--pass <password>` (the login username covers REST and chat/email alike).

### Chat & email (GraphQL)

Chat and email are **not** part of the REST API — they live on a separate GraphQL endpoint (`https://www.holdsport.dk/graphql`) with its own auth, reverse-engineered in [`CHAT_API.md`](CHAT_API.md). The client handles this transparently: it sends the required `X-App-Version` header, runs a `SignIn` mutation to mint a token, and reuses it for the read queries. The `chats` / `chat` / `emails` / `email` commands and tools (plus the experimental `gql-*` activities below) are GraphQL, and all are read-only.

`chats` lists both your ad-hoc rooms (the ones you're directly added to) and the team-scoped rooms — team, coach, and parent chats — across all your teams, just like the app. `chat <room_id>` shows any room's transcript by id, whatever its scope.

`emails` lists your inbox most-recent first (subject, sender, date, read state; `--sent` for the sent box); `email <id>` shows one email's body and attachments. Note that bulk-email bodies are stored as HTML, so `email` content may contain HTML and merge placeholders like `{{ fornavn }}`.

`SignIn` requires the **login username** (e.g. `troelsknaknielsen`) — not the email or member number. Since REST Basic auth also accepts the login username, a single `HOLDSPORT_USERNAME` set to it works for every command.

#### Experimental: richer activities (`gql-*`)

`gql-activities` and `gql-activity` are GraphQL-backed takes on the REST `activities` / `activity` / `attendees` / `headcount`, kept under a separate namespace while they prove out. `gql-activities [date]` lists a team's upcoming activities (type, place, sign-up count), paginated with `--page`. `gql-activity <id>` shows one activity with a full attendance breakdown — counts plus, with `--names`, the named attending / not-attending / no-answer lists (the REST `headcount` only gave names by status). If they work out, they'll be renamed to take over the canonical names and the REST versions removed.

Minted tokens are cached in-process, keyed by login — so the long-lived MCP server can serve multiple users without ever handing one login's token to another, and repeat chat calls skip re-authenticating.

## MCP server

The MCP server is **read-only** — every tool maps to a specific read, with no raw request/path escape hatch, so an agent driving it can never reach an unintended endpoint or modify Holdsport data. The chat/email tools are GraphQL reads only (`SignIn` authenticates but writes nothing, and no generic GraphQL tool is exposed), so the guarantee holds there too.

Credentials are passed on **every tool call**: each tool takes `username` and `password` arguments (team-scoped tools also take `team_id`), and a fresh client is built per call. The server itself takes no arguments and holds no credentials — the MCP host supplies them with each invocation.

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

`teams`, `members`, `member`, `roster`, `notes`, `activities`, `activity`, `attendees`, `headcount`, `tasks`, `user`, `profiles`, `chats`, `chat`, `emails`, `email`, and the experimental `gql_activities` / `gql_activity`. Every tool requires `username` and `password`; team-scoped tools also need a `team_id`. The GraphQL tools (`chats`, `chat`, `emails`, `email`, `gql_activities`, `gql_activity`) authenticate over GraphQL, so their `username` must be the **login username**, not the email.
