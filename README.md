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
bun bin/holdsport activities <activity_id> --names
bun bin/holdsport chats
bun bin/holdsport chats <room_id> --limit 20
bun bin/holdsport emails --limit 20
bun bin/holdsport emails <email_id>
```

Team-scoped commands default to `HOLDSPORT_TEAM_ID`; override per call with `--team <id>`. Output is human-readable by default; add `--json` (the `roster` command also has `--csv`). The CLI is read-only and exposes only the named read commands — there is no raw-request escape hatch.

The list commands are plural and take an optional id to show a single item instead: `members 1234`, `activities 1234`, `chats 1234`, `emails 1234`. (The MCP server keeps these as separate `members`/`member`, `activities`/`activity`, … tools.)

Credentials default to the environment but can be overridden per call with `--user <login>` / `--pass <password>` (the login username covers REST and chat/email alike).

### Chat & email (GraphQL)

Chat, email, and activities are **not** part of the REST API — they live on a separate GraphQL endpoint (`https://www.holdsport.dk/graphql`) with its own auth, reverse-engineered in [`CHAT_API.md`](CHAT_API.md). The client handles this transparently: it sends the required `X-App-Version` header, runs a `SignIn` mutation to mint a token, and reuses it for the read queries. These commands and tools (`chats` / `chat` / `emails` / `email` / `activities` / `activity`) are GraphQL, and all are read-only.

`chats` lists both your ad-hoc rooms (the ones you're directly added to) and the team-scoped rooms — team, coach, and parent chats — across all your teams, just like the app. `chats <room_id>` shows any room's transcript by id, whatever its scope.

`emails` lists your inbox most-recent first (subject, sender, date, read state; `--sent` for the sent box); `emails <email_id>` shows one email's body and attachments. Note that bulk-email bodies are stored as HTML, so the content may contain HTML and merge placeholders like `{{ fornavn }}`.

`activities [date]` lists a team's upcoming activities (type, place, sign-up count), paginated with `--page`. `activities <activity_id>` shows one activity with a full attendance breakdown — counts plus, with `--names`, the named attending / not-attending / no-answer lists.

`SignIn` requires the **login username** (e.g. `troelsknaknielsen`) — not the email or member number. Since REST Basic auth also accepts the login username, a single `HOLDSPORT_USERNAME` set to it works for every command.

Minted tokens are cached in-process, keyed by login — so the long-lived MCP server can serve multiple users without ever handing one login's token to another, and repeat calls skip re-authenticating.

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

`teams`, `members`, `member`, `roster`, `notes`, `activities`, `activity`, `tasks`, `user`, `profiles`, `chats`, `chat`, `emails`, and `email`. Every tool requires `username` and `password`; team-scoped tools also need a `team_id`. The GraphQL tools (`chats`, `chat`, `emails`, `email`, `activities`, `activity`) authenticate over GraphQL, so their `username` must be the **login username**, not the email.
