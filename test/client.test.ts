import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  clearChatTokenCache,
  type Config,
  HoldsportClient,
  loadConfig,
} from "../src/client.ts";

const baseConfig: Config = {
  username: "u",
  password: "p",
  baseUrl: "https://api.example.test/v1",
  teamId: "99",
};

/** Replace global fetch with a canned-response handler for the duration of a test. */
function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  ) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), { status, statusText });

describe("loadConfig", () => {
  const ENV_KEYS = [
    "HOLDSPORT_USERNAME",
    "HOLDSPORT_PASSWORD",
    "HOLDSPORT_BASE_URL",
    "HOLDSPORT_TEAM_ID",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // Start each test from a clean env so .env values don't leak in.
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws when credentials are missing", () => {
    expect(() => loadConfig()).toThrow(/Missing credentials/);
  });

  it("reads credentials from the environment and defaults the base URL", () => {
    process.env.HOLDSPORT_USERNAME = "envuser";
    process.env.HOLDSPORT_PASSWORD = "envpass";
    process.env.HOLDSPORT_TEAM_ID = "42";
    const c = loadConfig();
    expect(c.username).toBe("envuser");
    expect(c.password).toBe("envpass");
    expect(c.teamId).toBe("42");
    expect(c.baseUrl).toBe("https://api.holdsport.dk/v1");
  });

  it("lets overrides win over the environment", () => {
    process.env.HOLDSPORT_USERNAME = "envuser";
    process.env.HOLDSPORT_PASSWORD = "envpass";
    const c = loadConfig({
      username: "argu",
      password: "argp",
      teamId: "7",
      baseUrl: "https://x",
    });
    expect(c.username).toBe("argu");
    expect(c.password).toBe("argp");
    expect(c.teamId).toBe("7");
    expect(c.baseUrl).toBe("https://x");
  });
});

describe("HoldsportClient.request", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends Basic auth, builds the URL, and parses JSON", async () => {
    let seenUrl = "";
    let seenAuth: unknown;
    stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return json({ ok: true });
    });
    const data = await new HoldsportClient(baseConfig).get("teams");
    expect(data).toEqual({ ok: true });
    expect(seenUrl).toBe("https://api.example.test/v1/teams");
    expect(seenAuth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("appends query params, skipping undefined", async () => {
    let seenUrl = "";
    stubFetch((url) => {
      seenUrl = url;
      return json([]);
    });
    await new HoldsportClient(baseConfig).get("teams/1/activities", {
      date: "2026-06-01",
      page: 2,
      per_page: undefined,
    });
    expect(seenUrl).toContain("date=2026-06-01");
    expect(seenUrl).toContain("page=2");
    expect(seenUrl).not.toContain("per_page");
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(() => json({ error: "nope" }, 404, "Not Found"));
    await expect(new HoldsportClient(baseConfig).get("teams/1")).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

const MEMBERS = [
  {
    id: 1,
    firstname: "Bo",
    lastname: "Berg",
    role: 1,
    birthday: "2009-01-02",
    member_number: "100",
    addresses: [
      { mobile: "111", email: "bo@x.dk" },
      { mobile: "111", email: "false" }, // duplicate mobile + "false" sentinel
    ],
  },
  {
    id: 2,
    firstname: "Ann",
    lastname: "Adler",
    role: 2,
    birthday: "1980-05-05",
    member_number: "200",
    addresses: [{ mobile: "false", email: "ann@x.dk" }],
  },
  {
    id: 3,
    firstname: "Cy",
    lastname: "Cohen",
    role: 1,
    birthday: "2010-03-03",
    member_number: "300",
    addresses: [],
  },
];

describe("HoldsportClient.roster", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    stubFetch(() => json(MEMBERS));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shapes rows, drops the 'false' sentinel, dedups, and sorts by role then name", async () => {
    const rows = await new HoldsportClient(baseConfig).roster();
    expect(rows.map((r) => r.name)).toEqual(["Bo Berg", "Cy Cohen", "Ann Adler"]);
    expect(rows[0]).toEqual({
      name: "Bo Berg",
      role: "player",
      birthday: "2009-01-02",
      mobile: "111",
      email: "bo@x.dk",
      member_number: "100",
    });
    expect(rows[2].mobile).toBe(""); // "false" was filtered out
  });

  it("filters to players when requested", async () => {
    const rows = await new HoldsportClient(baseConfig).roster(undefined, {
      players: true,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.role === "player")).toBe(true);
  });
});

const ACTIVITY_DETAIL = {
  id: 555,
  activities_users: [
    { user_id: 1, name: "Bo", status: "Tilmeldt", status_code: 1 },
    { user_id: 2, name: "Ann", status: "Afmeldt", status_code: 2 },
    { user_id: 3, name: "Cy", status: "Tilmeldt", status_code: 1 },
    { user_id: 4, name: "Dee" }, // no answer -> "(ukendt)"
  ],
};

describe("HoldsportClient.headcount", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("tallies by status, ordered by status_code, including no-answers", async () => {
    stubFetch(() => json(ACTIVITY_DETAIL));
    const hc = await new HoldsportClient(baseConfig).headcount("555");
    expect(hc.activity_id).toBe(555);
    expect(hc.total).toBe(4);
    expect(Object.keys(hc.status)).toEqual(["Tilmeldt", "Afmeldt", "(ukendt)"]);
    expect(hc.status).toEqual({ Tilmeldt: 2, Afmeldt: 1, "(ukendt)": 1 });
    expect(hc.people).toHaveLength(4);
  });

  it("narrows to role-1 players by joining on member id", async () => {
    const playerMembers = [
      { id: 1, role: 1 },
      { id: 2, role: 2 }, // Ann is staff -> dropped
      { id: 3, role: 1 },
      { id: 4, role: 1 },
    ];
    stubFetch((url) =>
      url.endsWith("/members") ? json(playerMembers) : json(ACTIVITY_DETAIL),
    );
    const hc = await new HoldsportClient(baseConfig).headcount("555", undefined, {
      players: true,
    });
    expect(hc.total).toBe(3);
    expect(hc.status).toEqual({ Tilmeldt: 2, "(ukendt)": 1 });
  });
});

// --- Chat (GraphQL) --------------------------------------------------------

const chatConfig: Config = {
  ...baseConfig,
  graphqlUrl: "https://gql.example.test/graphql",
};

const CHAT_ROOMS = [
  {
    id: 10,
    name: "Team chat ",
    scope: "team",
    unread_count: 2,
    activity: null,
    latest_chat_message: {
      text: "see you",
      created_at: { iso8601: "2025-01-10T18:00:00+01:00" },
      user: { name: "Bo Berg ", firstname: "Bo" },
    },
  },
  {
    id: 11,
    name: "Match thread",
    scope: "activity",
    unread_count: 0,
    activity: { id: 555, name: "Match" },
    latest_chat_message: {
      text: "older",
      created_at: { iso8601: "2025-01-09T10:00:00+01:00" },
      user: { name: "Ann Adler", firstname: "Ann" },
    },
  },
  {
    id: 12,
    name: "Empty room",
    scope: "rooms_users",
    unread_count: 0,
    activity: null,
    latest_chat_message: null,
  },
];

// Deliberately out of chronological order to exercise sorting.
const CHAT_MESSAGES = [
  {
    id: 3,
    text: "third",
    created_at: { iso8601: "2025-01-10T12:00:00+01:00", to_i: 300 },
    user: { name: "Cy Cohen", firstname: "Cy" },
    images: [],
  },
  {
    id: 1,
    text: "first",
    created_at: { iso8601: "2025-01-10T10:00:00+01:00", to_i: 100 },
    user: { name: "Bo Berg", firstname: "Bo" },
    images: [{ id: 9, url: "https://img/1" }],
  },
  {
    id: 2,
    text: "second\nline",
    created_at: { iso8601: "2025-01-10T11:00:00+01:00", to_i: 200 },
    user: { name: "Ann Adler", firstname: "Ann" },
    images: [],
  },
];

/**
 * Stub the GraphQL endpoint, dispatching on the operation in the request body.
 * Returns the number of SignIn calls so tests can assert token memoization.
 */
function stubGraphql(
  opts: {
    rooms?: unknown;
    teams?: unknown;
    room?: unknown;
    received?: unknown;
    sent?: unknown;
    email?: unknown;
  } = {},
): {
  signIns: () => number;
  requests: () => Array<{ auth?: string; query: string }>;
} {
  const requests: Array<{ auth?: string; query: string }> = [];
  stubFetch((_url, init) => {
    const body = JSON.parse(String(init.body));
    requests.push({
      auth: (init.headers as Record<string, string>)?.Authorization,
      query: body.query,
    });
    if (body.query.includes("SignIn")) {
      return json({ data: { SignIn: { access_token: "tok-123" } } });
    }
    if (body.query.includes("rooms_users_chat_rooms")) {
      return json({
        data: {
          current_user: {
            id: 1,
            rooms_users_chat_rooms: opts.rooms ?? CHAT_ROOMS,
            teams: opts.teams ?? [],
          },
        },
      });
    }
    if (body.query.includes("chat_room")) {
      return json({ data: { chat_room: opts.room ?? null } });
    }
    if (body.query.includes("received_emails")) {
      return json({ data: { received_emails: opts.received ?? [] } });
    }
    if (body.query.includes("sent_emails")) {
      return json({ data: { sent_emails: opts.sent ?? [] } });
    }
    if (body.query.includes("email(id:")) {
      return json({ data: { email: opts.email ?? null } });
    }
    return json({});
  });
  return {
    signIns: () => requests.filter((r) => r.query.includes("SignIn")).length,
    requests: () => requests,
  };
}

describe("HoldsportClient chat (GraphQL)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearChatTokenCache(); // the token cache is process-level; isolate each test
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  it("signs in once, then shapes + sorts rooms by last-message time desc", async () => {
    const spy = stubGraphql();
    const client = new HoldsportClient(chatConfig);
    const rooms = await client.listChatRooms();

    expect(spy.signIns()).toBe(1);
    expect(rooms.map((r) => r.id)).toEqual([10, 11, 12]); // 12 (no message) last
    expect(rooms[0]).toEqual({
      id: 10,
      name: "Team chat",
      scope: "team",
      unread_count: 2,
      last_message: {
        author: "Bo Berg",
        text: "see you",
        time: "2025-01-10T18:00:00+01:00",
      },
      activity: null,
    });
    expect(rooms[1].activity).toEqual({ id: 555, name: "Match" });
    expect(rooms[2].last_message).toBeNull();
  });

  it("merges team-scoped rooms with ad-hoc rooms, deduped by id", async () => {
    stubGraphql({
      rooms: [CHAT_ROOMS[0]], // room 10, scope rooms_users
      teams: [
        {
          id: 100,
          chat_rooms_scoped: [
            {
              id: 20,
              name: "Hold-chat",
              scope: "team",
              unread_count: 0,
              activity: null,
              latest_chat_message: {
                text: "hi team",
                created_at: { iso8601: "2025-01-11T09:00:00+01:00" },
                user: { name: "Coach" },
              },
            },
            // Same id as the ad-hoc room 10 — must be dropped as a duplicate.
            { id: 10, name: "dup", scope: "team", unread_count: 0, activity: null, latest_chat_message: null },
          ],
        },
      ],
    });
    const rooms = await new HoldsportClient(chatConfig).listChatRooms();
    expect(rooms.map((r) => r.id)).toEqual([20, 10]); // team room (Jan 11) before room 10 (Jan 10)
    expect(rooms.find((r) => r.id === 10)!.name).toBe("Team chat"); // ad-hoc copy kept, not "dup"
  });

  it("sends the SignIn token as a raw Authorization header on the query", async () => {
    const spy = stubGraphql();
    await new HoldsportClient(chatConfig).listChatRooms();
    const query = spy.requests().find((r) => r.query.includes("rooms_users_chat_rooms"));
    expect(query?.auth).toBe("tok-123"); // raw token, no "Bearer " prefix
  });

  it("memoizes the token across calls (one SignIn for two reads)", async () => {
    const spy = stubGraphql({ room: { id: 10, name: "r", scope: "team", unread_count: 0, chat_messages: [] } });
    const client = new HoldsportClient(chatConfig);
    await client.listChatRooms();
    await client.chatRoom(10);
    expect(spy.signIns()).toBe(1);
  });

  it("caches across client instances but keys by username", async () => {
    const spy = stubGraphql();
    // Two distinct logins each sign in; reusing a login hits the shared cache.
    await new HoldsportClient({ ...chatConfig, username: "alice" }).listChatRooms();
    await new HoldsportClient({ ...chatConfig, username: "bob" }).listChatRooms();
    await new HoldsportClient({ ...chatConfig, username: "alice" }).listChatRooms();
    expect(spy.signIns()).toBe(2); // alice + bob; the second alice is a cache hit
  });

  it("skips SignIn when an access token is configured", async () => {
    const spy = stubGraphql();
    await new HoldsportClient({ ...chatConfig, accessToken: "preset" }).listChatRooms();
    expect(spy.signIns()).toBe(0);
    const query = spy.requests().find((r) => r.query.includes("rooms_users_chat_rooms"));
    expect(query?.auth).toBe("preset");
  });

  it("shapes a room's messages oldest-first with image urls", async () => {
    stubGraphql({
      room: {
        id: 10,
        name: "Team chat",
        scope: "team",
        unread_count: 1,
        chat_messages: CHAT_MESSAGES,
      },
    });
    const room = await new HoldsportClient(chatConfig).chatRoom("10");
    expect(room.messages.map((m) => m.id)).toEqual([1, 2, 3]); // sorted by to_i
    expect(room.messages[0]).toEqual({
      id: 1,
      time: "2025-01-10T10:00:00+01:00",
      author: "Bo Berg",
      text: "first",
      images: ["https://img/1"],
    });
    expect(room.messages[1].text).toBe("second\nline");
  });

  it("trims to the most recent N but keeps chronological order", async () => {
    stubGraphql({
      room: { id: 10, name: "r", scope: "team", unread_count: 0, chat_messages: CHAT_MESSAGES },
    });
    const room = await new HoldsportClient(chatConfig).chatRoom("10", 2);
    expect(room.messages.map((m) => m.id)).toEqual([2, 3]); // newest two, in order
  });

  it("throws a clear error on the empty-{} gate response", async () => {
    stubFetch(() => json({}));
    await expect(new HoldsportClient(chatConfig).listChatRooms()).rejects.toThrow(
      /no data|X-App-Version/,
    );
  });

  it("surfaces GraphQL errors", async () => {
    stubFetch(() => json({ errors: [{ message: "nope" }] }));
    await expect(new HoldsportClient(chatConfig).listChatRooms()).rejects.toThrow(
      /GraphQL error: nope/,
    );
  });

  it("throws when SignIn returns no token", async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("SignIn")) return json({ data: { SignIn: {} } });
      return json({ data: {} });
    });
    await expect(new HoldsportClient(chatConfig).listChatRooms()).rejects.toThrow(
      /no access_token/,
    );
  });
});

const INBOX = [
  {
    id: 11,
    subject: "Older notice ",
    has_been_read: true,
    created_at: { iso8601: "2025-01-09T10:00:00+01:00" },
    sender: { id: 5, name: "Coach Bo" },
    attachment1_name: null,
  },
  {
    id: 12,
    subject: "Newest, with file",
    has_been_read: false,
    created_at: { iso8601: "2025-01-12T08:00:00+01:00" },
    sender: { id: 6, name: "Admin Ann" },
    attachment1_name: "agenda.pdf",
  },
];

describe("HoldsportClient email (GraphQL)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearChatTokenCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  it("shapes the inbox newest-first with read + attachment flags", async () => {
    stubGraphql({ received: INBOX });
    const emails = await new HoldsportClient(chatConfig).listEmails();
    expect(emails.map((e) => e.id)).toEqual([12, 11]); // newest first
    expect(emails[0]).toEqual({
      id: 12,
      subject: "Newest, with file",
      sender: "Admin Ann",
      time: "2025-01-12T08:00:00+01:00",
      has_been_read: false,
      has_attachments: true,
    });
    expect(emails[1].has_attachments).toBe(false);
  });

  it("reads the sent box when sent:true", async () => {
    const spy = stubGraphql({ sent: [INBOX[0]] });
    const emails = await new HoldsportClient(chatConfig).listEmails({ sent: true });
    expect(emails).toHaveLength(1);
    expect(spy.requests().some((r) => r.query.includes("sent_emails"))).toBe(true);
  });

  it("limits to the most recent N", async () => {
    stubGraphql({ received: INBOX });
    const emails = await new HoldsportClient(chatConfig).listEmails({ limit: 1 });
    expect(emails.map((e) => e.id)).toEqual([12]);
  });

  it("shapes a single email with recipients and non-empty attachments", async () => {
    stubGraphql({
      email: {
        id: 12,
        subject: "Newest",
        content: "Hello team",
        has_been_read: false,
        created_at: { iso8601: "2025-01-12T08:00:00+01:00" },
        sender: { id: 6, name: "Admin Ann" },
        recipients: [{ id: 1, name: "Bo Berg" }, { id: 2, name: "Cy Cohen" }],
        attachment1_name: "agenda.pdf",
        attachment1_url: "https://files/agenda.pdf",
        attachment2_name: null,
        attachment2_url: null,
        attachment3_name: null,
        attachment3_url: null,
      },
    });
    const email = await new HoldsportClient(chatConfig).getEmail("12");
    expect(email.content).toBe("Hello team");
    expect(email.recipients).toEqual(["Bo Berg", "Cy Cohen"]);
    expect(email.attachments).toEqual([
      { name: "agenda.pdf", url: "https://files/agenda.pdf" },
    ]);
  });

  it("throws when the email is not found", async () => {
    stubGraphql({ email: null });
    await expect(new HoldsportClient(chatConfig).getEmail(999)).rejects.toThrow(
      /email 999 not found/,
    );
  });
});
