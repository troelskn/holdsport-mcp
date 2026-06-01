import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { type Config, HoldsportClient, loadConfig } from "../src/client.ts";

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
