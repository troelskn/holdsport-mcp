/**
 * Holdsport API client — the data + business logic shared by the CLI and the
 * MCP server.
 *
 * Two backends live behind one client:
 *  - The REST API (https://api.holdsport.dk/v1) over HTTP Basic auth, for
 *    teams/members/activities/etc. (`request`/`get` and the methods built on
 *    them).
 *  - The GraphQL API (https://www.holdsport.dk/graphql) for chat, which REST
 *    doesn't expose. It needs the `X-App-Version` header to answer at all, a
 *    `SignIn` mutation to mint an access token, and that token echoed back in a
 *    raw `Authorization` header. See CHAT_API.md for the reverse-engineered
 *    details. Chat reads are exposed via `listChatRooms`/`chatRoom`.
 *
 * Nothing in here writes to the terminal or calls process.exit: methods return
 * plain JS data and throw `Error` on failure, so each front-end decides how to
 * surface results and errors (the CLI prints + exits; the MCP server maps throws
 * to tool errors).
 *
 * API docs: https://github.com/Holdsport/holdsport-api
 */

export const DEFAULT_BASE_URL = "https://api.holdsport.dk/v1";
export const DEFAULT_GRAPHQL_URL = "https://www.holdsport.dk/graphql";

/**
 * The GraphQL endpoint silently returns an empty `{}` for every request unless
 * it sees an `X-App-Version` header (any non-empty value works). This is the
 * value the v8 app sends.
 */
const APP_VERSION = "8.0.199";

export interface Config {
  username: string;
  password: string;
  baseUrl: string;
  /** Default team for team-scoped calls when no explicit id is given. */
  teamId?: string;
  /** GraphQL (chat) endpoint. Defaults to {@link DEFAULT_GRAPHQL_URL}. */
  graphqlUrl?: string;
  /**
   * Login username for the GraphQL `SignIn` (chat). Must be the *login
   * username* — not the email and not the member number — which can differ
   * from the REST `username`. Falls back to `username` when unset.
   */
  chatUsername?: string;
  /** Pre-obtained GraphQL access token; skips the `SignIn` round-trip. */
  accessToken?: string;
}

export type Query = Record<string, string | number | undefined>;

/**
 * Build a Config from explicit overrides, falling back to environment variables
 * for any field not supplied. Throws if username/password can't be resolved.
 *
 * The CLI calls this with no arguments (pure env). The MCP server passes the
 * credentials it parsed from its command-line flags as overrides.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const username = overrides.username ?? process.env.HOLDSPORT_USERNAME;
  const password = overrides.password ?? process.env.HOLDSPORT_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Missing credentials. Provide a username and password " +
        "(CLI: HOLDSPORT_USERNAME / HOLDSPORT_PASSWORD; MCP: --username / --password).",
    );
  }

  return {
    username,
    password,
    baseUrl:
      overrides.baseUrl ?? process.env.HOLDSPORT_BASE_URL ?? DEFAULT_BASE_URL,
    teamId: overrides.teamId ?? process.env.HOLDSPORT_TEAM_ID,
    graphqlUrl:
      overrides.graphqlUrl ??
      process.env.HOLDSPORT_GRAPHQL_URL ??
      DEFAULT_GRAPHQL_URL,
    chatUsername: overrides.chatUsername ?? process.env.HOLDSPORT_CHAT_USERNAME,
    accessToken: overrides.accessToken ?? process.env.HOLDSPORT_ACCESS_TOKEN,
  };
}

interface MemberRecord {
  id?: number;
  firstname?: string;
  lastname?: string;
  role?: number;
  birthday?: string;
  member_number?: string;
  addresses?: Array<{ mobile?: string; email?: string }>;
}

export interface RosterEntry {
  name: string;
  role: string;
  birthday: string;
  mobile: string;
  email: string;
  member_number: string;
}

export interface Headcount {
  activity_id: number;
  total: number;
  /** Status label → count, ordered by Holdsport's status_code (1 = Tilmeldt …). */
  status: Record<string, number>;
  people: Array<{
    user_id?: number;
    name?: string;
    status?: string;
    status_code?: number;
  }>;
}

/** A chat room as shown in the room list, shaped for humans. */
export interface ChatRoomSummary {
  id: number;
  name: string;
  /** `rooms_users` (ad-hoc), `team`, `activity`, … */
  scope: string;
  unread_count: number;
  /** The most recent message's author, text, and ISO timestamp, if any. */
  last_message: { author: string; text: string; time: string } | null;
  /** The activity a room is attached to, for activity-scoped rooms. */
  activity: { id: number; name: string } | null;
}

/** A single chat message, shaped for humans. */
export interface ChatMessage {
  id: number;
  /** ISO-8601 timestamp. */
  time: string;
  author: string;
  text: string;
  /** Attached image/file URLs, if any. */
  images: string[];
}

/** A chat room with its messages, oldest first. */
export interface ChatRoomDetail {
  id: number;
  name: string;
  scope: string;
  unread_count: number;
  messages: ChatMessage[];
}

/** Mint an access token from a login username + password. */
const SIGN_IN = `mutation SignIn($username: String, $password: String) {
  SignIn(input: { username: $username, password: $password }) {
    access_token
  }
}`;

/** List the current user's chat rooms with a one-line preview of each. */
const LIST_CHAT_ROOMS = `query ListChatRooms {
  current_user {
    id
    rooms_users_chat_rooms {
      id
      name
      scope
      unread_count
      activity { id name }
      latest_chat_message {
        text
        created_at { iso8601 }
        user { id name firstname }
      }
    }
  }
}`;

/** A single room with its full message history. */
const SHOW_CHAT_ROOM = `query ShowChatRoom($id: Int!) {
  chat_room(id: $id) {
    id
    name
    scope
    unread_count
    chat_messages {
      id
      text
      created_at { iso8601 to_i }
      user { id name firstname }
      images { id url }
    }
  }
}`;

/**
 * Process-level cache of GraphQL access tokens, keyed by endpoint + login
 * username so a token minted for one login is never handed to another. It is
 * shared across client instances on purpose: the MCP server builds a fresh
 * client per tool call, so an instance-local cache would re-run `SignIn` on
 * every chat call. Sharing it lets a token be reused for the rest of the
 * session, while the key keeps each login's token separate.
 *
 * There is no expiry handling yet — call {@link clearChatTokenCache} if a token
 * ever goes stale.
 */
const accessTokenCache = new Map<string, string>();

/**
 * Drop all cached chat access tokens. Useful if a token expires; also used by
 * tests to keep `SignIn` counts deterministic.
 */
export function clearChatTokenCache(): void {
  accessTokenCache.clear();
}

export class HoldsportClient {
  constructor(private readonly config: Config) {}

  /** Perform an authenticated request and return the parsed JSON body. Throws on non-2xx. */
  async request(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<unknown> {
    const url = new URL(
      path.startsWith("http")
        ? path
        : `${this.config.baseUrl}/${path.replace(/^\/+/, "")}`,
    );
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const auth = Buffer.from(
      `${this.config.username}:${this.config.password}`,
    ).toString("base64");

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for ${method} ${url.pathname}${url.search}\n${text}`,
      );
    }

    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Raw GET escape hatch; flags become query params. */
  get(path: string, query?: Query): Promise<unknown> {
    return this.request("GET", path, { query });
  }

  /** Resolve the target team from an explicit id, else the configured default. */
  private resolveTeam(teamId?: string): string {
    const team = teamId ?? this.config.teamId;
    if (!team) {
      throw new Error(
        "no team set: pass a team id or configure a default team " +
          "(CLI: --team / HOLDSPORT_TEAM_ID; MCP: team_id / --team-id)",
      );
    }
    return String(team);
  }

  listTeams(): Promise<unknown> {
    return this.request("GET", "teams");
  }

  listMembers(teamId?: string): Promise<unknown> {
    return this.request("GET", `teams/${this.resolveTeam(teamId)}/members`);
  }

  getMember(memberId: string, teamId?: string): Promise<unknown> {
    return this.request(
      "GET",
      `teams/${this.resolveTeam(teamId)}/members/${memberId}`,
    );
  }

  /** Contact list shaped for humans: name/role/mobile/email per member. */
  async roster(
    teamId?: string,
    opts: { players?: boolean; staff?: boolean } = {},
  ): Promise<RosterEntry[]> {
    const data = await this.request(
      "GET",
      `teams/${this.resolveTeam(teamId)}/members`,
    );
    let members = (Array.isArray(data) ? data : []) as MemberRecord[];

    if (opts.players) members = members.filter((m) => m.role === 1);
    if (opts.staff) members = members.filter((m) => m.role === 2);

    const roleLabel = (role?: number) =>
      role === 1 ? "player" : role === 2 ? "staff" : String(role ?? "");
    // Holdsport returns the string "false" as a null sentinel for empty fields.
    const distinct = (values: Array<unknown>) =>
      [
        ...new Set(
          values
            .map((v) => String(v ?? "").trim())
            .filter((s) => s && s.toLowerCase() !== "false"),
        ),
      ].join("; ");

    return members
      .map((m) => {
        const addrs = m.addresses ?? [];
        return {
          name: `${m.firstname ?? ""} ${m.lastname ?? ""}`
            .replace(/\s+/g, " ")
            .trim(),
          role: roleLabel(m.role),
          birthday: m.birthday ?? "",
          mobile: distinct(addrs.map((a) => a.mobile)),
          email: distinct(addrs.map((a) => a.email)),
          member_number: m.member_number ?? "",
        };
      })
      .sort(
        (a, b) =>
          a.role.localeCompare(b.role) || a.name.localeCompare(b.name, "da"),
      );
  }

  listNotes(teamId?: string): Promise<unknown> {
    return this.request("GET", `teams/${this.resolveTeam(teamId)}/notes`);
  }

  listActivities(
    teamId?: string,
    opts: {
      date?: string;
      page?: string | number;
      perPage?: string | number;
    } = {},
  ): Promise<unknown> {
    return this.request("GET", `teams/${this.resolveTeam(teamId)}/activities`, {
      query: { date: opts.date, page: opts.page, per_page: opts.perPage },
    });
  }

  getActivity(activityId: string, teamId?: string): Promise<unknown> {
    return this.request(
      "GET",
      `teams/${this.resolveTeam(teamId)}/activities/${activityId}`,
    );
  }

  listAttendees(activityId: string): Promise<unknown> {
    return this.request("GET", `activities/${activityId}/activities_users`);
  }

  /** Tally an activity's invited list by status. */
  async headcount(
    activityId: string,
    teamId?: string,
    opts: { players?: boolean } = {},
  ): Promise<Headcount> {
    const team = this.resolveTeam(teamId);
    // The team activity-detail endpoint embeds the *full* invited list,
    // including no-answers (Ukendt). The /activities/:id/activities_users
    // endpoint omits them, so it can't be trusted for a headcount.
    const data = (await this.request(
      "GET",
      `teams/${team}/activities/${activityId}`,
    )) as { activities_users?: unknown };
    let users = (
      Array.isArray(data?.activities_users) ? data.activities_users : []
    ) as Array<{
      status?: string;
      status_code?: number;
      name?: string;
      user_id?: number;
    }>;

    // The invite list mixes players with coaches/leaders/parents. The players
    // option narrows it to actual players (role 1) by joining on member id.
    if (opts.players) {
      const membersData = await this.request("GET", `teams/${team}/members`);
      const members = (
        Array.isArray(membersData) ? membersData : []
      ) as Array<{ id?: number; role?: number }>;
      const playerIds = new Set(
        members.filter((m) => m.role === 1).map((m) => m.id),
      );
      users = users.filter((u) => playerIds.has(u.user_id));
    }

    // Group by the human-readable status; remember each status_code so we
    // can order the buckets (1 = Tilmeldt, 2 = Afmeldt, ...).
    const groups = new Map<string, { code: number; names: string[] }>();
    for (const u of users) {
      const status = u.status ?? "(ukendt)";
      const code = typeof u.status_code === "number" ? u.status_code : 99;
      const group = groups.get(status) ?? { code, names: [] };
      group.names.push(u.name ?? "(unnamed)");
      groups.set(status, group);
    }
    const ordered = [...groups.entries()].sort((a, b) => a[1].code - b[1].code);

    return {
      activity_id: Number(activityId),
      total: users.length,
      status: Object.fromEntries(
        ordered.map(([status, g]) => [status, g.names.length]),
      ),
      people: users.map((u) => ({
        user_id: u.user_id,
        name: u.name,
        status: u.status,
        status_code: u.status_code,
      })),
    };
  }

  listTasks(activityId: string): Promise<unknown> {
    return this.request("GET", `activities/${activityId}/activity_tasks`);
  }

  getUser(): Promise<unknown> {
    return this.request("GET", "user");
  }

  listProfiles(): Promise<unknown> {
    return this.request("GET", "profiles");
  }

  // --- Chat (GraphQL) ------------------------------------------------------
  //
  // Chat lives on a separate GraphQL endpoint with its own auth. These helpers
  // keep that self-contained: `graphql` is the transport, `accessToken` mints +
  // caches the token, and the public `listChatRooms`/`chatRoom` shape the result.

  /**
   * POST a GraphQL operation and return its `data`. Sends the `X-App-Version`
   * gate header (without it the server answers `{}`); authenticated operations
   * also carry the raw `Authorization` token. Throws on HTTP errors, on a
   * GraphQL `errors` array, and on the empty-`{}` gate response.
   */
  private async graphql(
    query: string,
    variables: Record<string, unknown> = {},
    opts: { authenticated?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const url = this.config.graphqlUrl ?? DEFAULT_GRAPHQL_URL;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-App-Version": APP_VERSION,
    };
    if (opts.authenticated !== false) {
      headers.Authorization = await this.accessToken();
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for GraphQL\n${text}`);
    }

    let body: { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`GraphQL returned non-JSON: ${text.slice(0, 200)}`);
    }

    if (body.errors?.length) {
      throw new Error(
        `GraphQL error: ${body.errors.map((e) => e.message ?? "?").join("; ")}`,
      );
    }
    if (!body.data) {
      // An empty `{}` means the X-App-Version gate rejected us (or the endpoint
      // isn't the GraphQL one). Surface it clearly rather than as "undefined".
      throw new Error(
        "GraphQL returned no data (the X-App-Version gate may have rejected the request).",
      );
    }
    return body.data;
  }

  /**
   * The GraphQL access token, minting one via `SignIn` on first use and caching
   * it in the process-level {@link accessTokenCache} (keyed by endpoint + login)
   * for reuse across calls. A `config.accessToken` short-circuits the SignIn
   * entirely.
   */
  private async accessToken(): Promise<string> {
    if (this.config.accessToken) return this.config.accessToken;

    // Key the cache by endpoint + resolved login, so a token minted for one set
    // of credentials is never served to a different login within the process.
    const url = this.config.graphqlUrl ?? DEFAULT_GRAPHQL_URL;
    const username = this.config.chatUsername ?? this.config.username;
    const key = `${url} ${username}`;
    const cached = accessTokenCache.get(key);
    if (cached) return cached;
    // TODO: no token-expiry handling. A cached token can go stale mid-session,
    // and the API signals that with a null `current_user` / null `data` rather
    // than an HTTP 401 — so a read just comes back empty instead of erroring. To
    // auto-recover, detect that empty/unauthenticated shape in the read methods,
    // evict this key, and re-SignIn + retry once. For now a stale token needs
    // clearChatTokenCache() or a process restart.

    const data = await this.graphql(
      SIGN_IN,
      { username, password: this.config.password },
      { authenticated: false },
    );
    const token = (data.SignIn as { access_token?: string } | null)?.access_token;
    if (!token) {
      throw new Error(
        "SignIn returned no access_token. Chat uses the login username " +
          "(not email / member number); set it via HOLDSPORT_CHAT_USERNAME / chat_username.",
      );
    }
    accessTokenCache.set(key, token);
    return token;
  }

  /** The current user's chat rooms, most-recently-active first. */
  async listChatRooms(): Promise<ChatRoomSummary[]> {
    const data = await this.graphql(LIST_CHAT_ROOMS);
    const user = data.current_user as {
      rooms_users_chat_rooms?: Array<{
        id: number;
        name?: string;
        scope?: string;
        unread_count?: number;
        activity?: { id: number; name?: string } | null;
        latest_chat_message?: {
          text?: string;
          created_at?: { iso8601?: string } | null;
          user?: { name?: string; firstname?: string } | null;
        } | null;
      }>;
    } | null;
    const rooms = user?.rooms_users_chat_rooms ?? [];

    return rooms
      .map((r) => {
        const last = r.latest_chat_message;
        return {
          id: r.id,
          name: (r.name ?? "").trim(),
          scope: r.scope ?? "",
          unread_count: r.unread_count ?? 0,
          last_message: last
            ? {
                author: (last.user?.name ?? last.user?.firstname ?? "").trim(),
                text: last.text ?? "",
                time: last.created_at?.iso8601 ?? "",
              }
            : null,
          activity: r.activity
            ? { id: r.activity.id, name: (r.activity.name ?? "").trim() }
            : null,
        };
      })
      .sort((a, b) => (b.last_message?.time ?? "").localeCompare(a.last_message?.time ?? ""));
  }

  /**
   * A single chat room with its messages, oldest first. `limit`, when given,
   * keeps only the most recent N messages (still shown chronologically); the
   * GraphQL API has no server-side limit, so this trims client-side.
   */
  async chatRoom(roomId: string | number, limit?: number): Promise<ChatRoomDetail> {
    const data = await this.graphql(SHOW_CHAT_ROOM, { id: Number(roomId) });
    const room = data.chat_room as {
      id: number;
      name?: string;
      scope?: string;
      unread_count?: number;
      chat_messages?: Array<{
        id: number;
        text?: string;
        created_at?: { iso8601?: string; to_i?: number } | null;
        user?: { name?: string; firstname?: string } | null;
        images?: Array<{ url?: string }> | null;
      }>;
    } | null;
    if (!room) throw new Error(`chat room ${roomId} not found`);

    let messages = (room.chat_messages ?? [])
      .map((m) => ({
        id: m.id,
        time: m.created_at?.iso8601 ?? "",
        ts: m.created_at?.to_i ?? 0,
        author: (m.user?.name ?? m.user?.firstname ?? "").trim(),
        text: m.text ?? "",
        images: (m.images ?? [])
          .map((img) => img.url ?? "")
          .filter((u) => u),
      }))
      .sort((a, b) => a.ts - b.ts);

    // Trim to the most recent N, but keep them in chronological order.
    if (limit !== undefined && limit >= 0 && messages.length > limit) {
      messages = messages.slice(messages.length - limit);
    }

    return {
      id: room.id,
      name: (room.name ?? "").trim(),
      scope: room.scope ?? "",
      unread_count: room.unread_count ?? 0,
      messages: messages.map(({ ts: _ts, ...m }) => m),
    };
  }
}
