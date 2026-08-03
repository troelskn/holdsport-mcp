# Holdsport MCP

Scriptable access to [Holdsport](https://holdsport.dk), the club-management platform, from the terminal or from an AI agent.

Two things that make this different from other Holdsport tooling:

- **It goes beyond the REST API.** The [documented REST API](https://github.com/Holdsport/holdsport-api) covers teams, members, and basic activity sign-ups, which is where most integrations stop. This one also talks to the mobile app's private GraphQL API to read **chat** (team / coach / parent rooms), **email** (your inbox and the bulk mailings clubs send out), and a richer **activities & attendance** view — live sign-up counts plus the named attending / not-attending / no-answer lists that REST doesn't expose.
- **It runs as an MCP server.** Besides the CLI, it ships an [MCP](https://modelcontextprotocol.io) server, so you can ask Claude (Cowork) or any MCP host to pull a roster or tally attendance without wiring up the API yourself.

Under the hood there are two binaries over one shared data layer:

- **`bin/holdsport`** — the CLI (rosters, schedule, attendance, chat, email) for the terminal.
- **`bin/holdsport-mcp`** — the MCP server, exposing the same commands as tools.

All commands are **read-only** except two deliberate writes — creating and editing an activity — each gated behind an explicit `--yes` on the CLI and a `confirm: true` argument on the MCP tool (see [Creating & editing activities](#creating--editing-activities-the-only-writes)). Everything else cannot modify data, making it safe to connect to an agent.

To install on your local machine, using Claude Cowork, see: [Register with Claude Cowork](#register-with-claude-cowork)

The shared API client + business logic lives in [`src/client.ts`](src/client.ts); CLI-only terminal rendering lives in [`src/render.ts`](src/render.ts).

## Setup

```sh
bun install
bun test     # unit tests (offline — network is mocked)
```

Holdsport has two backends, both handled by the shared client: a REST API (HTTP Basic auth) for teams/members/roster/etc., and a GraphQL API for chat, email, and activities (see [Chat & email](#chat--email-graphql) below). A single Holdsport login covers both.

## CLI

Credentials come from the environment (Bun auto-loads `.env`):

```sh
# .env
HOLDSPORT_USERNAME=your-login   # login username (not email/member no.), see below
HOLDSPORT_PASSWORD=your-password
HOLDSPORT_TEAM_ID=12345         # default team for team-scoped commands
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

Team-scoped commands default to `HOLDSPORT_TEAM_ID`; override per call with `--team <id>`. Output is human-readable by default; add `--json` (the `roster` command also has `--csv`). The CLI exposes only the named commands — there is no raw-request escape hatch — and the only ones that write are `activities create` and `activities edit` (below).

The list commands are plural and take an optional id to show a single item instead: `members 1234`, `activities 1234`, `chats 1234`, `emails 1234`. (The MCP server keeps these as separate `members`/`member`, `activities`/`activity`, … tools.)

Credentials default to the environment but can be overridden per call with `--user <login>` / `--pass <password>` (the login username covers REST and chat/email alike).

### Chat & email (GraphQL)

Chat, email, and activities are **not** part of the REST API — they live on a separate GraphQL endpoint (`https://www.holdsport.dk/graphql`) with its own auth, reverse-engineered from the mobile app. The client handles this transparently: it sends the required `X-App-Version` header, runs a `SignIn` mutation to mint a token, and reuses it for the read queries. These commands and tools (`chats` / `chat` / `emails` / `email` / `activities` / `activity`) are GraphQL, and all are read-only.

`chats` lists both your ad-hoc rooms (the ones you're directly added to) and the team-scoped rooms — team, coach, and parent chats — across all your teams, just like the app. `chats <room_id>` shows any room's transcript by id, whatever its scope.

`emails` lists your inbox most-recent first (subject, sender, date, read state; `--sent` for the sent box); `emails <email_id>` shows one email's body and attachments. Note that bulk-email bodies are stored as HTML, so the content may contain HTML and merge placeholders like `{{ fornavn }}`.

`activities [date]` lists a team's upcoming activities (type, place, meeting time, sign-up count), paginated with `--page`. `activities <activity_id>` shows one activity with a full attendance breakdown — counts plus, with `--names`, the named attending / not-attending / no-answer lists. Activities carry an optional meeting time (Mødetid, the API's `pickup_time`), exposed as `meeting_time` and shown as the `Meet` column/line.

`SignIn` requires the **login username** (e.g. `your-login`) — not the email or member number. Since REST Basic auth also accepts the login username, a single `HOLDSPORT_USERNAME` set to it works for every command.

### Creating & editing activities (the only writes)

`activities create` puts a new activity on the team's calendar, and `activities edit <id>` changes an existing one — the only commands in the tool that modify Holdsport data. Both are **dry-run by default**: without `--yes`, `create` prints what would be created (no network at all) and `edit` prints an `old → new` diff (a read, no write); only `--yes` writes.

```sh
bun bin/holdsport event-types                # list the team's event types (for --event-type)
bun bin/holdsport activities create \
  --name "Ekstra træning" --date 2026-08-10 --start 17:00 --end 18:30 \
  --place Hallen --event-type 123456 --comment "Medbring bold" \
  --yes                                      # omit --yes to preview without creating
bun bin/holdsport activities edit 55901234 --start 17:30 --place "Hal 2" --yes
```

For `create`, `--name`, `--date` (YYYY-MM-DD), and `--start` (HH:MM, 24-hour, team-local time) are required; `--end`, `--end-date`, `--meet` (meeting time / Mødetid, HH:MM), `--place`, `--comment`, `--event-type <id>`, `--max <n>`, and `--registration-type <type>` are optional. `edit` takes any subset of the same flags — fields you don't mention keep their current values. Payloads are validated client-side before anything is sent.

`--registration-type` (MCP: `registration_type`) is the sign-up mode — the app's *Tilmeldingstype* dropdown: `normal` (members sign up themselves; the server's default for new activities), `pick_out` (the coach picks the squad / Udtagelse), `available` (members mark availability), `everybody_attending` (everyone is signed up by default), `pick_out_sub_teams`, or `no_registration` (no sign-up at all). On the wire this is the mutations' `activity_type` int — the name↔code mapping is documented in the GraphQL schema's own description of `Activity.type`. On `edit`, a registration-type code this client doesn't know (a future server value) is preserved verbatim rather than guessed at.

How it works, and what to know before using it:

- Both run GraphQL mutations (`CreateActivity` / `UpdateActivity`; REST has no write endpoints). The mutations take **no team argument** — they target the login's *current team* — so the client first runs `ChangeCurrentTeam` and refuses to write unless the server confirms the switch landed on the right team. For `create` that's the configured/`--team` team; for `edit` it's the activity's *own* team, read from the activity itself. Side effect: your "current team" in the Holdsport app switches too.
- `edit` is **read-modify-write**: it fetches the activity's current state (converting the API's UTC instants to Danish wall-clock time), merges your changes over the editable fields, and sends everything back — the editable fields plus a verbatim echo of the other server-assigned settings (reminders, registration windows, waiting list, …). The echo is mandatory: `UpdateActivity` assigns every input field and **NULLs the omitted ones** (verified against production — a partial update without `activity_type` dies on the column's NOT NULL constraint), so a partial send would silently wipe settings. Payment activities are refused outright, since their payment fields can't be read back and echoed.
- For an activity in a **repeating series**, `edit` (CLI and MCP alike) always changes **only that occurrence** — where the app's save dialog offers "this and future", this tool deliberately hardcodes the single-occurrence choice by sending the mutation's `update_current_and_future: false` explicitly. Series-wide edits stay in the app. (The shared client's `updateActivity` accepts a `repeatScope` option, but no front-end exposes `"future"`.) One-off activities never carry the flag.
- **This tool exposes no way to delete an activity** — treat creates as consequential. (The API can delete: `CancelActivity` with `mark_as_canceled: false` removes an activity outright, verified live — but no command or tool wraps it, deliberately.)
- The wire format for times is **verified against production**: the mutations ignore the separate `start_date`/`end_date` input fields and parse `start_time`/`end_time` as full `YYYY-MM-DD HH:MM` datetimes — a bare `HH:MM` would land the activity on *today's* date. The client builds the combined form from your `--date`/`--start`/`--end` flags, so the CLI/MCP interface is unchanged.

Minted tokens are cached in-process, keyed by login — so the long-lived MCP server can serve multiple users without ever handing one login's token to another, and repeat calls skip re-authenticating.

## MCP server

Every MCP tool maps to a specific operation, with no raw request/path escape hatch, so an agent driving it can never reach an unintended endpoint. All tools are reads except `create_activity` and `update_activity` (see [Creating & editing activities](#creating--editing-activities-the-only-writes)), which require an explicit `confirm: true` argument — their descriptions instruct the agent to show the user the details and get approval before setting it. The chat/email tools are GraphQL reads only (`SignIn` authenticates but writes nothing, and no generic GraphQL tool is exposed).

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
        "/Users/troelskn/Projects/holdsport-mcp/bin/holdsport-mcp"
      ]
    }
  }
}
```

The host (or the model) provides `username`/`password` with each tool call.

See also: [https://coworkerai.io/guide/mcp-setup](https://coworkerai.io/guide/mcp-setup)

### Tools

`teams`, `members`, `member`, `roster`, `notes`, `activities`, `activity`, `event_types`, `create_activity`, `update_activity`, `tasks`, `user`, `profiles`, `chats`, `chat`, `emails`, and `email`. Every tool requires `username` and `password`; team-scoped tools also need a `team_id`. The GraphQL tools (`chats`, `chat`, `emails`, `email`, `activities`, `activity`, `event_types`, `create_activity`, `update_activity`) authenticate over GraphQL, so their `username` must be the **login username**, not the email. `create_activity` and `update_activity` are the only tools that write; everything else is read-only.
