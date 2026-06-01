import { describe, expect, it } from "bun:test";

import type { Headcount, RosterEntry } from "../src/client.ts";
import {
  cell,
  csvField,
  isScalar,
  renderHeadcount,
  renderHuman,
  rosterCsv,
  rosterTable,
  table,
} from "../src/render.ts";

describe("cell", () => {
  it("formats ISO timestamps as Danish date-time", () => {
    expect(cell("2026-06-01T18:30:00Z")).toBe("01-06-2026 18:30");
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

describe("renderHeadcount", () => {
  const hc: Headcount = {
    activity_id: 555,
    total: 3,
    status: { Tilmeldt: 2, Afmeldt: 1 },
    people: [
      { user_id: 1, name: "Bo", status: "Tilmeldt", status_code: 1 },
      { user_id: 3, name: "Cy", status: "Tilmeldt", status_code: 1 },
      { user_id: 2, name: "Ann", status: "Afmeldt", status_code: 2 },
    ],
  };

  it("renders an indented status tally without names by default", () => {
    const out = renderHeadcount(hc);
    expect(out).toContain("Activity 555");
    expect(out).toContain("Tilmeldt");
    expect(out).toContain("Total");
    expect(out).not.toContain("- Bo");
  });

  it("lists each name under its status when asked", () => {
    const out = renderHeadcount(hc, { names: true });
    expect(out).toContain("- Bo");
    expect(out).toContain("- Cy");
    expect(out).toContain("- Ann");
  });
});
