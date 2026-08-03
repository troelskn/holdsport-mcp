# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Runtime is **Bun** (not Node) — both binaries have `#!/usr/bin/env bun` shebangs, and `tsconfig.json` uses `allowImportingTsExtensions`/`noEmit` (imports carry `.ts` extensions; Bun runs the TypeScript directly).

```sh
bun install
bun test                        # all tests — offline, global fetch is mocked
bun test test/client.test.ts    # one file
bun test -t "pattern"           # tests matching a name pattern
bunx tsc --noEmit               # type check (no build step exists)

bun bin/holdsport help          # run the CLI (credentials from .env, auto-loaded by Bun)
bun bin/holdsport-mcp           # run the MCP server (stdio)
```

CLI credentials come from `.env`: `HOLDSPORT_USERNAME`, `HOLDSPORT_PASSWORD`, `HOLDSPORT_TEAM_ID`. The username must be the **login username** (not email or member number) — GraphQL `SignIn` accepts only that form.

## Architecture

Two front-ends over one shared data layer:

- `src/client.ts` — `HoldsportClient`: all API access and business logic, shared by both binaries. Returns plain JS data and throws `Error`; it never prints or calls `process.exit` — each front-end decides presentation (CLI prints and exits; MCP maps throws to tool errors).
- `src/render.ts` — CLI-only terminal rendering (tables, CSV, transcripts). The MCP server never imports it; it returns pretty-printed JSON.
- `bin/holdsport` — CLI: arg parsing + dispatch to client + render.
- `bin/holdsport-mcp` — MCP server: pure tool wiring around the client. Credentials arrive **per tool call** (`username`/`password`/`team_id` arguments); a fresh client is built per call and the server itself holds no credentials or startup args.

### Two backends inside the client

- **REST** (`https://api.holdsport.dk/v1`, HTTP Basic auth): teams, members, roster, notes, tasks. Documented at https://github.com/Holdsport/holdsport-api.
- **GraphQL** (`https://www.holdsport.dk/graphql`): chat, email, activities, event types — reverse-engineered from the mobile app, not documented anywhere. It silently returns `{}` without an `X-App-Version` header; auth is a `SignIn` mutation that mints a token, cached in-process per login (`accessTokenCache` / `clearChatTokenCache`). Query/mutation strings live as constants in `client.ts`.

### Read-only by design — preserve this

Everything is a read except `createActivity` / `updateActivity`. Deliberate safety properties that must not be eroded:

- No raw request/path/GraphQL escape hatch in the CLI or MCP tools.
- Writes are gated: CLI `--yes` (dry-run/diff by default), MCP `confirm: true`.
- No delete is exposed anywhere. The API *can* delete — `CancelActivity` with `mark_as_canceled: false` removes an activity outright (verified live) — but no command or tool wraps it, deliberately.

### Write-path invariants (verified against production — don't "simplify" them away)

- The create/update mutations take **no team argument**; they hit the login's *current team*. The client therefore runs `ChangeCurrentTeam` first and refuses to write unless the server confirms the switch landed on the intended team — for create that's the configured/`--team` team, for update the activity's *own* team, read from the activity itself. Visible side effect: the login's current team in the Holdsport app switches too.
- `updateActivity` is **read-modify-write with a full echo**: the server NULLs every input field omitted from `UpdateActivityInput`, so the client fetches current state, merges changes, and sends everything back. A partial send silently wipes settings (verified: an update omitting `activity_type` dies on that column's NOT NULL constraint). Payment activities are refused because their fields can't be read back.
- The CLI/MCP `registration_type` names map to the mutations' `activity_type` int; the name↔code mapping is documented in the GraphQL schema's own description of `Activity.type`. On update, a code this client doesn't know (a future server value) is echoed verbatim, never guessed.
- Times on the wire are full `YYYY-MM-DD HH:MM` datetimes in `start_time`/`end_time` (the separate date fields are ignored by the server; a bare `HH:MM` lands on today). All wall-clock conversion uses `Europe/Copenhagen` (`TEAM_TZ` in client.ts).
- Edits to repeating-series activities always send `update_current_and_future: false` — single occurrence only, hardcoded in both front-ends (`updateActivity` accepts a `repeatScope` option, but no front-end exposes `"future"`); one-off activities never carry the flag.
- Activity `meeting_time` (Mødetid) maps to the API's `pickup_time` field.

## Tests

`bun:test`, fully offline: `stubFetch` in `test/client.test.ts` replaces `globalThis.fetch` with canned responses, and env vars are saved/restored around tests so the real `.env` doesn't leak in. New client behavior should follow this pattern — no live network in tests.
