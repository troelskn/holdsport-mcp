import { describe, expect, it } from "bun:test";

import type {
  ActivityDetail,
  ActivitySummary,
  ChatRoomDetail,
  ChatRoomSummary,
  EmailDetail,
  EmailSummary,
  RosterEntry,
} from "../src/client.ts";
import {
  cell,
  csvField,
  isScalar,
  renderActivities,
  renderActivity,
  renderChatRooms,
  renderChatTranscript,
  renderEmail,
  renderEmails,
  renderHuman,
  rosterCsv,
  rosterTable,
  table,
} from "../src/render.ts";

describe("cell", () => {
  it("converts UTC instants to Danish local time (CEST in summer)", () => {
    // 18:30Z in June is CEST (+02:00) → 20:30
    expect(cell("2026-06-01T18:30:00Z")).toBe("01-06-2026 20:30");
  });

  it("converts UTC instants to Danish local time (CET in winter)", () => {
    // 18:30Z in January is CET (+01:00) → 19:30
    expect(cell("2026-01-15T18:30:00Z")).toBe("15-01-2026 19:30");
  });

  it("honours an explicit offset, normalising to Danish time", () => {
    // 22:00 at +00:00 is 23:00 in CET
    expect(cell("2026-01-15T22:00:00+00:00")).toBe("15-01-2026 23:00");
  });

  it("reformats a zone-less timestamp without shifting it", () => {
    expect(cell("2026-06-04T16:10:00")).toBe("04-06-2026 16:10");
  });

  it("renders null/undefined as empty", () => {
    expect(cell(null)).toBe("");
    expect(cell(undefined)).toBe("");
  });

  it("collapses whitespace", () => {
    expect(cell("  a   b\n c ")).toBe("a b c");
  });
});

describe("csvField", () => {
  it("leaves plain values unquoted", () => {
    expect(csvField("plain")).toBe("plain");
  });

  it("quotes and escapes when needed", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
  });
});

describe("isScalar", () => {
  it("treats primitives and null as scalar", () => {
    expect(isScalar("x")).toBe(true);
    expect(isScalar(1)).toBe(true);
    expect(isScalar(true)).toBe(true);
    expect(isScalar(null)).toBe(true);
  });

  it("treats objects and arrays as non-scalar", () => {
    expect(isScalar({})).toBe(false);
    expect(isScalar([])).toBe(false);
  });
});

describe("table", () => {
  it("aligns columns under a header underline", () => {
    const lines = table(["A", "BB"], [["1", "22"], ["333", "4"]]).split("\n");
    expect(lines).toHaveLength(4); // header, underline, 2 rows
    expect(lines[0]).toBe("A    BB");
    expect(lines[1]).toBe("───  ──");
  });
});

describe("renderHuman", () => {
  it("renders an empty array as (none)", () => {
    expect(renderHuman([])).toBe("(none)");
  });

  it("renders an array of objects as a table with a row count", () => {
    const out = renderHuman(
      [{ id: 1, name: "Bo" }, { id: 2, name: "Ann" }],
      { fields: ["id", "name"] },
    );
    expect(out).toContain("Bo");
    expect(out.trim().endsWith("2 rows")).toBe(true);
  });

  it("renders a single object as a key/value list", () => {
    const out = renderHuman({ id: 7, name: "Bo" }, { fields: ["id", "name"] });
    expect(out.split("\n")).toEqual(["id    7", "name  Bo"]);
  });
});

const ROWS: RosterEntry[] = [
  {
    name: "Bo Berg",
    role: "player",
    birthday: "2009-01-02",
    mobile: "111",
    email: "bo@x.dk",
    member_number: "100",
  },
  {
    name: "Ann, Adler",
    role: "staff",
    birthday: "1980-05-05",
    mobile: "",
    email: "ann@x.dk",
    member_number: "200",
  },
];

describe("rosterCsv", () => {
  it("emits a header and quotes fields containing commas", () => {
    const lines = rosterCsv(ROWS).split("\n");
    expect(lines[0]).toBe("name,role,birthday,mobile,email,member_number");
    expect(lines[1]).toBe("Bo Berg,player,2009-01-02,111,bo@x.dk,100");
    expect(lines[2]).toContain('"Ann, Adler"');
  });
});

describe("rosterTable", () => {
  it("includes a player/staff summary line", () => {
    expect(rosterTable(ROWS)).toContain("2 members (1 players, 1 staff)");
  });
});

describe("renderChatRooms", () => {
  const rooms: ChatRoomSummary[] = [
    {
      id: 10,
      name: "Team chat",
      scope: "team",
      unread_count: 2,
      last_message: {
        author: "Bo Berg",
        text: "see you there",
        time: "2025-01-10T18:00:00+01:00",
      },
      activity: null,
    },
    {
      id: 12,
      name: "Empty room",
      scope: "rooms_users",
      unread_count: 0,
      last_message: null,
      activity: null,
    },
  ];

  it("renders a row per room with unread marker and first-name preview", () => {
    const out = renderChatRooms(rooms);
    expect(out).toContain("Team chat");
    expect(out).toContain("●2"); // unread marker
    expect(out).toContain("Bo: see you there"); // first name + text
    expect(out).toContain("10-01-2025 18:00"); // formatted time
    expect(out).toContain("2 rooms");
  });

  it("handles no rooms", () => {
    expect(renderChatRooms([])).toBe("(no chat rooms)");
  });
});

describe("renderChatTranscript", () => {
  const room: ChatRoomDetail = {
    id: 10,
    name: "Team chat",
    scope: "team",
    unread_count: 1,
    messages: [
      {
        id: 1,
        time: "2025-01-10T10:00:00+01:00",
        author: "Bo Berg",
        text: "first\nwith two lines",
        images: ["https://img/1"],
      },
      {
        id: 2,
        time: "2025-01-10T11:00:00+01:00",
        author: "Ann Adler",
        text: "reply",
        images: [],
      },
    ],
  };

  it("renders a header and one block per message", () => {
    const out = renderChatTranscript(room);
    expect(out).toContain("# Team chat  [team]  room 10  (1 unread)");
    expect(out).toContain("[10-01-2025 10:00] Bo Berg");
    expect(out).toContain("  first");
    expect(out).toContain("  with two lines"); // multi-line text indented
    expect(out).toContain("  [image] https://img/1");
    expect(out).toContain("[10-01-2025 11:00] Ann Adler");
  });

  it("notes an empty room", () => {
    expect(renderChatTranscript({ ...room, messages: [] })).toContain("(no messages)");
  });
});

describe("renderEmails", () => {
  const emails: EmailSummary[] = [
    {
      id: 12,
      subject: "Newest",
      sender: "Admin Ann",
      time: "2025-01-12T08:00:00+01:00",
      has_been_read: false,
      has_attachments: true,
    },
    {
      id: 11,
      subject: "Older",
      sender: "Coach Bo",
      time: "2025-01-09T10:00:00+01:00",
      has_been_read: true,
      has_attachments: false,
    },
  ];

  it("renders a row per email with unread + attachment markers", () => {
    const out = renderEmails(emails);
    expect(out).toContain("Newest");
    expect(out).toContain("●"); // unread marker on email 12
    expect(out).toContain("Admin Ann");
    expect(out).toContain("12-01-2025 08:00");
    expect(out).toContain("2 emails");
  });

  it("handles an empty list", () => {
    expect(renderEmails([])).toBe("(no emails)");
  });
});

describe("renderEmail", () => {
  const email: EmailDetail = {
    id: 12,
    subject: "Team update",
    sender: "Admin Ann",
    recipients: ["Bo Berg", "Cy Cohen"],
    time: "2025-01-12T08:00:00+01:00",
    has_been_read: false,
    content: "Hello\nteam",
    attachments: [{ name: "agenda.pdf", url: "https://files/agenda.pdf" }],
  };

  it("renders a header block then the body", () => {
    const out = renderEmail(email);
    expect(out).toContain("# Team update");
    expect(out).toContain("From:  Admin Ann");
    expect(out).toContain("Date:  12-01-2025 08:00");
    expect(out).toContain("To:    2 recipients");
    expect(out).toContain("Status: unread");
    expect(out).toContain("@ agenda.pdf  https://files/agenda.pdf");
    expect(out).toContain("Hello\nteam");
  });
});

describe("renderActivities", () => {
  const rows: ActivitySummary[] = [
    {
      id: 1,
      name: "Træning",
      time: "2026-06-04T16:10:00+02:00",
      end_time: "2026-06-04T17:40:00+02:00",
      place: "Hallen",
      event_type: "Træning",
      is_cancelled: false,
      attendee_count: 22,
    },
    {
      id: 2,
      name: "Match",
      time: "2026-06-05T18:00:00+02:00",
      end_time: "",
      place: "Away",
      event_type: "Kamp",
      is_cancelled: true,
      attendee_count: 12,
    },
  ];

  it("renders a row per activity with type, place, count, and a cancel marker", () => {
    const out = renderActivities(rows);
    expect(out).toContain("Træning");
    expect(out).toContain("Hallen");
    expect(out).toContain("22");
    expect(out).toContain("✗ Match"); // cancelled marker
    expect(out).toContain("2 activities");
  });

  it("handles an empty list", () => {
    expect(renderActivities([])).toBe("(no activities)");
  });
});

describe("renderActivity", () => {
  const detail: ActivityDetail = {
    id: 7,
    name: "Sommertræning",
    time: "2026-06-04T16:10:00+02:00",
    end_time: "2026-06-04T17:40:00+02:00",
    place: "Rødovre",
    comment: "Husk drikkedunk",
    event_type: "Træning",
    is_cancelled: false,
    counts: { attending: 3, players: 2, coaches: 1, max: 999 },
    attendance: {
      attending_players: ["Bo Berg", "Cy Cohen"],
      attending_coaches: ["Coach Ann"],
      not_attending: ["Dee Day"],
      no_answer: [],
    },
    waiting_list: 2,
    tasks: 1,
  };

  it("renders header and tally without names by default", () => {
    const out = renderActivity(detail);
    expect(out).toContain("# Sommertræning");
    expect(out).toContain("When:  04-06-2026 16:10 – 04-06-2026 17:40");
    expect(out).toContain("Attending:     3  (2 players, 1 coaches)");
    expect(out).toContain("Not attending: 1");
    expect(out).toContain("Waiting list:  2");
    expect(out).not.toContain("- Bo Berg"); // names hidden by default
  });

  it("lists the named buckets when asked", () => {
    const out = renderActivity(detail, { names: true });
    expect(out).toContain("Attending — players (2):");
    expect(out).toContain("  - Bo Berg");
    expect(out).toContain("Not attending (1):");
    expect(out).toContain("  - Dee Day");
    expect(out).not.toContain("No answer ("); // empty bucket omitted
  });
});
