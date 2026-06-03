/**
 * Holdsport API client — the data + business logic shared by the CLI and the
 * MCP server.
 *
 * Two backends live behind one client:
 *  - The REST API (https://api.holdsport.dk/v1) over HTTP Basic auth, for
 *    teams/members/roster/etc. (the private `get` and the methods built on it).
 *  - The GraphQL API (https://www.holdsport.dk/graphql) for chat, email, and
 *    activities, which REST doesn't expose. It needs the `X-App-Version` header
 *    to answer at all, a `SignIn` mutation to mint an access token, and that
 *    token echoed back in a raw `Authorization` header — all reverse-engineered
 *    from the mobile app.
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
  /**
   * Holdsport login username, used for both REST (Basic auth) and GraphQL
   * (chat/email `SignIn`). It must be the *login username* — not the email and
   * not the member number — because chat only accepts that form (REST accepts
   * any of the three).
   */
  username: string;
  password: string;
  /** Default team for team-scoped calls when no explicit id is given. */
  teamId?: string;
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
    teamId: overrides.teamId ?? process.env.HOLDSPORT_TEAM_ID,
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

/** An email as shown in an inbox/sent list, shaped for humans. */
export interface EmailSummary {
  id: number;
  subject: string;
  sender: string;
  /** ISO-8601 timestamp. */
  time: string;
  has_been_read: boolean;
  has_attachments: boolean;
}

export interface EmailAttachment {
  name: string;
  url: string;
}

/** A single email with its body and attachments. */
export interface EmailDetail {
  id: number;
  subject: string;
  sender: string;
  /** Recipient names (these blasts can have hundreds). */
  recipients: string[];
  time: string;
  has_been_read: boolean;
  /** Body; may contain HTML. */
  content: string;
  attachments: EmailAttachment[];
}

// --- Activities (GraphQL) --------------------------------------------------
// Activities/attendance run over GraphQL: the list carries a live sign-up count
// per activity, and the detail returns the full attendance breakdown by name.

/** An activity as shown in the list, shaped for humans. */
export interface ActivitySummary {
  id: number;
  name: string;
  /** ISO-8601 start timestamp. */
  time: string;
  /** ISO-8601 end timestamp. */
  end_time: string;
  place: string;
  event_type: string;
  is_cancelled: boolean;
  /** How many have signed up (players + coaches). */
  attendee_count: number;
}

/** A single activity with its full attendance breakdown, shaped for humans. */
export interface ActivityDetail {
  id: number;
  name: string;
  time: string;
  end_time: string;
  place: string;
  comment: string;
  event_type: string;
  is_cancelled: boolean;
  counts: { attending: number; players: number; coaches: number; max: number };
  /** Names in each attendance bucket. */
  attendance: {
    attending_players: string[];
    attending_coaches: string[];
    not_attending: string[];
    no_answer: string[];
  };
  waiting_list: number;
  tasks: number;
}

/** Mint an access token from a login username + password. */
const SIGN_IN = `mutation SignIn($username: String, $password: String) {
  SignIn(input: { username: $username, password: $password }) {
    access_token
  }
}`;

/** Field set shared by both chat-room sources in the list query. */
const ROOM_SUMMARY_FIELDS = `
      id
      name
      scope
      unread_count
      activity { id name }
      latest_chat_message {
        text
        created_at { iso8601 }
        user { id name firstname }
      }`;

/**
 * List the current user's chat rooms with a one-line preview of each. Pulls two
 * sources the web app shows together: the ad-hoc rooms the user is a member of
 * (`rooms_users_chat_rooms`, scope `rooms_users`) and the team-scoped rooms
 * across all their teams (`chat_rooms_scoped`: team / coach / parent chats).
 */
const LIST_CHAT_ROOMS = `query ListChatRooms {
  current_user {
    id
    rooms_users_chat_rooms {${ROOM_SUMMARY_FIELDS}
    }
    teams {
      id
      chat_rooms_scoped {${ROOM_SUMMARY_FIELDS}
      }
    }
  }
}`;

/** Raw GraphQL shape of a chat room in the list query, before shaping. */
interface RawRoomSummary {
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
}

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

/** Field set shared by the inbox/sent list queries. */
const EMAIL_SUMMARY_FIELDS = `
    id
    subject
    has_been_read
    created_at { iso8601 }
    sender { id name }
    attachment1_name`;

/** List the current user's received or sent emails. */
const emailListQuery = (root: "received_emails" | "sent_emails") =>
  `query ListEmails {
  ${root} {${EMAIL_SUMMARY_FIELDS}
  }
}`;

/** A single email with its body and attachments. */
const SHOW_EMAIL = `query ShowEmail($id: Int!) {
  email(id: $id) {
    id
    subject
    content
    has_been_read
    created_at { iso8601 }
    sender { id name }
    recipients { id name }
    attachment1_name
    attachment1_url
    attachment2_name
    attachment2_url
    attachment3_name
    attachment3_url
  }
}`;

/** Raw GraphQL shape of an email, before shaping. */
interface RawEmail {
  id: number;
  subject?: string;
  content?: string;
  has_been_read?: boolean;
  created_at?: { iso8601?: string } | null;
  sender?: { name?: string } | null;
  recipients?: Array<{ name?: string }> | null;
  attachment1_name?: string | null;
  attachment1_url?: string | null;
  attachment2_name?: string | null;
  attachment2_url?: string | null;
  attachment3_name?: string | null;
  attachment3_url?: string | null;
}

/** Per-activity fields shared by the rich list and detail queries. */
const ACTIVITY_FIELDS = `
    id
    name
    place
    is_cancelled
    starttime { iso8601 }
    endtime { iso8601 }
    event_type { name }
    attendee_count`;

/**
 * The team's upcoming activities, paginated and grouped by the server. We read
 * `future_activities_groups` (from `filter_start_date` onward) and flatten it.
 */
const LIST_ACTIVITIES = `query ListActivities($team: String, $start: String, $page: Int) {
  activities_page(team_id: $team, filter_start_date: $start, page: $page) {
    current_page
    future_activities_groups {
      activities {${ACTIVITY_FIELDS}
      }
    }
  }
}`;

/** A single activity with its full attendance breakdown. */
const SHOW_ACTIVITY = `query ShowActivity($id: Int!) {
  activity(id: $id) {${ACTIVITY_FIELDS}
    comment
    player_count
    coach_count
    max_attender
    attending_players { id name }
    attending_coaches { id name }
    non_attendees { id name }
    users_with_no_rsvp { id name }
    wait_list_entries { id }
    custom_tasks { id }
  }
}`;

/** Raw GraphQL shape of an activity row, before shaping. */
interface RawActivity {
  id: number;
  name?: string;
  place?: string;
  is_cancelled?: boolean;
  starttime?: { iso8601?: string } | null;
  endtime?: { iso8601?: string } | null;
  event_type?: { name?: string } | null;
  attendee_count?: number;
}

/** Raw GraphQL shape of the rich activity detail, before shaping. */
interface RawActivityDetail extends RawActivity {
  comment?: string;
  player_count?: number;
  coach_count?: number;
  max_attender?: number;
  attending_players?: Array<{ name?: string }> | null;
  attending_coaches?: Array<{ name?: string }> | null;
  non_attendees?: Array<{ name?: string }> | null;
  users_with_no_rsvp?: Array<{ name?: string }> | null;
  wait_list_entries?: Array<{ id: number }> | null;
  custom_tasks?: Array<{ id: number }> | null;
}

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

  /**
   * Perform an authenticated GET and return the parsed JSON body. Throws on
   * non-2xx. This is the only REST transport — the client is read-only, so there
   * is no write path. Private: external callers use the named read methods
   * below, not an arbitrary-path escape hatch.
   */
  private async get(path: string): Promise<unknown> {
    const url = new URL(
      path.startsWith("http")
        ? path
        : `${DEFAULT_BASE_URL}/${path.replace(/^\/+/, "")}`,
    );

    const auth = Buffer.from(
      `${this.config.username}:${this.config.password}`,
    ).toString("base64");

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for GET ${url.pathname}${url.search}\n${text}`,
      );
    }

    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
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
    return this.get("teams");
  }

  listMembers(teamId?: string): Promise<unknown> {
    return this.get(`teams/${this.resolveTeam(teamId)}/members`);
  }

  getMember(memberId: string, teamId?: string): Promise<unknown> {
    return this.get(
      `teams/${this.resolveTeam(teamId)}/members/${memberId}`,
    );
  }

  /** Contact list shaped for humans: name/role/mobile/email per member. */
  async roster(
    teamId?: string,
    opts: { players?: boolean; staff?: boolean } = {},
  ): Promise<RosterEntry[]> {
    const data = await this.get(
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
    return this.get(`teams/${this.resolveTeam(teamId)}/notes`);
  }

  listTasks(activityId: string): Promise<unknown> {
    return this.get(`activities/${activityId}/activity_tasks`);
  }

  getUser(): Promise<unknown> {
    return this.get("user");
  }

  listProfiles(): Promise<unknown> {
    return this.get("profiles");
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
    const url = DEFAULT_GRAPHQL_URL;
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
   * it in the process-level {@link accessTokenCache} (keyed by login) for reuse
   * across calls.
   */
  private async accessToken(): Promise<string> {
    // Key the cache by username, so a token minted for one set of
    // credentials is never served to a different login within the process.
    const username = this.config.username;
    const cached = accessTokenCache.get(username);
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
        "SignIn returned no access_token. Chat/email needs the login username " +
          "(not email / member number) — check HOLDSPORT_USERNAME / --user.",
      );
    }
    accessTokenCache.set(username, token);
    return token;
  }

  /**
   * The current user's chat rooms — both the ad-hoc rooms they belong to and the
   * team-scoped rooms across all their teams — deduped and most-recently-active
   * first. (Reading the messages of any of them works through `chatRoom`, which
   * fetches by id regardless of scope.)
   */
  async listChatRooms(): Promise<ChatRoomSummary[]> {
    const data = await this.graphql(LIST_CHAT_ROOMS);
    const user = data.current_user as {
      rooms_users_chat_rooms?: RawRoomSummary[];
      teams?: Array<{ chat_rooms_scoped?: RawRoomSummary[] }>;
    } | null;

    // Merge both sources; a room can be reachable via more than one relation, so
    // dedupe by id (the ad-hoc membership row wins as it comes first).
    const byId = new Map<number, RawRoomSummary>();
    for (const r of [
      ...(user?.rooms_users_chat_rooms ?? []),
      ...(user?.teams ?? []).flatMap((t) => t.chat_rooms_scoped ?? []),
    ]) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }

    return [...byId.values()]
      .map((r): ChatRoomSummary => {
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
      .sort((a, b) =>
        (b.last_message?.time ?? "").localeCompare(a.last_message?.time ?? ""),
      );
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

  /**
   * The current user's emails, most-recent first. Reads the inbox by default,
   * or the sent box with `sent: true`. `limit` keeps only the most recent N.
   */
  async listEmails(
    opts: { sent?: boolean; limit?: number } = {},
  ): Promise<EmailSummary[]> {
    const root = opts.sent ? "sent_emails" : "received_emails";
    const data = await this.graphql(emailListQuery(root));
    const raw = (data[root] as RawEmail[] | null) ?? [];

    const emails = raw
      .map(
        (e): EmailSummary => ({
          id: e.id,
          subject: (e.subject ?? "").trim(),
          sender: (e.sender?.name ?? "").trim(),
          time: e.created_at?.iso8601 ?? "",
          has_been_read: e.has_been_read ?? false,
          has_attachments: Boolean(e.attachment1_name),
        }),
      )
      .sort((a, b) => b.time.localeCompare(a.time));

    return opts.limit !== undefined && opts.limit >= 0
      ? emails.slice(0, opts.limit)
      : emails;
  }

  /** A single email with its body, recipients, and attachments. */
  async getEmail(emailId: string | number): Promise<EmailDetail> {
    const data = await this.graphql(SHOW_EMAIL, { id: Number(emailId) });
    const e = data.email as RawEmail | null;
    if (!e) throw new Error(`email ${emailId} not found`);

    const attachments: EmailAttachment[] = [
      { name: e.attachment1_name, url: e.attachment1_url },
      { name: e.attachment2_name, url: e.attachment2_url },
      { name: e.attachment3_name, url: e.attachment3_url },
    ]
      .filter((a) => a.name)
      .map((a) => ({ name: a.name ?? "", url: a.url ?? "" }));

    return {
      id: e.id,
      subject: (e.subject ?? "").trim(),
      sender: (e.sender?.name ?? "").trim(),
      recipients: (e.recipients ?? [])
        .map((r) => (r.name ?? "").trim())
        .filter((n) => n),
      time: e.created_at?.iso8601 ?? "",
      has_been_read: e.has_been_read ?? false,
      content: e.content ?? "",
      attachments,
    };
  }

  // --- Activities (GraphQL) ------------------------------------------------

  /**
   * The team's upcoming activities, one page at a time, from `date` onward
   * (defaults to today). Each row carries its event type, place, and a live
   * sign-up count.
   */
  async listActivities(
    opts: { teamId?: string; date?: string; page?: number } = {},
  ): Promise<ActivitySummary[]> {
    const team = this.resolveTeam(opts.teamId);
    const start = opts.date ?? new Date().toISOString().slice(0, 10);
    const data = await this.graphql(LIST_ACTIVITIES, {
      team,
      start,
      page: opts.page ?? 1,
    });
    const page = data.activities_page as {
      future_activities_groups?: Array<{ activities?: RawActivity[] }>;
    } | null;

    return (page?.future_activities_groups ?? [])
      .flatMap((g) => g.activities ?? [])
      .map(
        (a): ActivitySummary => ({
          id: a.id,
          name: (a.name ?? "").trim(),
          time: a.starttime?.iso8601 ?? "",
          end_time: a.endtime?.iso8601 ?? "",
          place: (a.place ?? "").trim(),
          event_type: (a.event_type?.name ?? "").trim(),
          is_cancelled: a.is_cancelled ?? false,
          attendee_count: a.attendee_count ?? 0,
        }),
      )
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  /**
   * A single activity with its full attendance breakdown: the named attending /
   * not-attending / no-answer lists plus the counts.
   */
  async getActivity(activityId: string | number): Promise<ActivityDetail> {
    const data = await this.graphql(SHOW_ACTIVITY, { id: Number(activityId) });
    const a = data.activity as RawActivityDetail | null;
    if (!a) throw new Error(`activity ${activityId} not found`);

    const names = (list?: Array<{ name?: string }> | null) =>
      (list ?? []).map((u) => (u.name ?? "").trim()).filter((n) => n);

    return {
      id: a.id,
      name: (a.name ?? "").trim(),
      time: a.starttime?.iso8601 ?? "",
      end_time: a.endtime?.iso8601 ?? "",
      place: (a.place ?? "").trim(),
      comment: (a.comment ?? "").trim(),
      event_type: (a.event_type?.name ?? "").trim(),
      is_cancelled: a.is_cancelled ?? false,
      counts: {
        attending: a.attendee_count ?? 0,
        players: a.player_count ?? 0,
        coaches: a.coach_count ?? 0,
        max: a.max_attender ?? 0,
      },
      attendance: {
        attending_players: names(a.attending_players),
        attending_coaches: names(a.attending_coaches),
        not_attending: names(a.non_attendees),
        no_answer: names(a.users_with_no_rsvp),
      },
      waiting_list: (a.wait_list_entries ?? []).length,
      tasks: (a.custom_tasks ?? []).length,
    };
  }
}
