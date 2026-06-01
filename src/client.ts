/**
 * Holdsport API client — the data + business logic shared by the CLI and the
 * MCP server.
 *
 * Talks to the Holdsport REST API (https://api.holdsport.dk/v1) over HTTP Basic
 * auth. Unlike the original single-file CLI, nothing in here writes to the
 * terminal or calls process.exit: methods return plain JS data and throw `Error`
 * on failure, so each front-end decides how to surface results and errors (the
 * CLI prints + exits; the MCP server maps throws to tool errors).
 *
 * API docs: https://github.com/Holdsport/holdsport-api
 */

const DEFAULT_BASE_URL = "https://api.holdsport.dk/v1";

export interface Config {
  username: string;
  password: string;
  baseUrl: string;
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
    baseUrl:
      overrides.baseUrl ?? process.env.HOLDSPORT_BASE_URL ?? DEFAULT_BASE_URL,
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
}
