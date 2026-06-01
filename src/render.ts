/**
 * Terminal presentation for the holdsport CLI.
 *
 * None of this is used by the MCP server (which returns raw JSON) — it lives
 * here purely to keep `bin/holdsport` thin. Every function is pure: it takes
 * data and returns a string.
 */

import type { Headcount, RosterEntry } from "./client.ts";

/** Render an aligned text table with a header underline. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [
    fmt(headers),
    widths.map((w) => "─".repeat(w)).join("  "),
    ...rows.map(fmt),
  ].join("\n");
}

/** Quote a CSV field if it contains a comma, quote, or newline. */
export function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Stringify a scalar for display; ISO timestamps become Danish DD-MM-YYYY HH:MM. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]} ${iso[4]}:${iso[5]}`;
  return s.replace(/\s+/g, " ").trim();
}

export function isScalar(value: unknown): boolean {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}

/**
 * Render API data for humans: an array of objects becomes a table, a single
 * object becomes a key/value list. `fields` picks/orders columns; without it,
 * every scalar field is shown. Long values are clipped.
 */
export function renderHuman(
  data: unknown,
  opts: { fields?: string[]; maxWidth?: number } = {},
): string {
  const maxWidth = opts.maxWidth ?? 60;
  const clip = (s: string) =>
    s.length > maxWidth ? `${s.slice(0, maxWidth - 1)}…` : s;

  if (Array.isArray(data)) {
    if (data.length === 0) return "(none)";
    const records = data.filter((x) => x && typeof x === "object");
    if (records.length !== data.length) {
      return data.map((v) => cell(v)).join("\n");
    }
    const objs = records as Array<Record<string, unknown>>;
    let cols = opts.fields;
    if (!cols) {
      cols = [];
      for (const o of objs) {
        for (const k of Object.keys(o)) {
          if (isScalar(o[k]) && !cols.includes(k)) cols.push(k);
        }
      }
    }
    const rows = objs.map((o) => cols!.map((k) => clip(cell(o[k]))));
    return `${table(cols, rows)}\n\n${data.length} rows`;
  }

  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const keys = opts.fields ?? Object.keys(o).filter((k) => isScalar(o[k]));
    if (keys.length === 0) return "(no fields)";
    const width = Math.max(...keys.map((k) => k.length));
    return keys.map((k) => `${k.padEnd(width)}  ${clip(cell(o[k]))}`).join("\n");
  }

  return cell(data);
}

/** Roster as an aligned table plus a player/staff summary line. */
export function rosterTable(rows: RosterEntry[]): string {
  const body = table(
    ["Name", "Role", "Mobile", "Email"],
    rows.map((r) => [r.name, r.role, r.mobile, r.email]),
  );
  const players = rows.filter((r) => r.role === "player").length;
  const staff = rows.filter((r) => r.role === "staff").length;
  return `${body}\n\n${rows.length} members (${players} players, ${staff} staff)`;
}

/** Roster as CSV (all fields). */
export function rosterCsv(rows: RosterEntry[]): string {
  const headers = [
    "name",
    "role",
    "birthday",
    "mobile",
    "email",
    "member_number",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [r.name, r.role, r.birthday, r.mobile, r.email, r.member_number]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\n");
}

/** Headcount as an indented status tally, optionally listing each name. */
export function renderHeadcount(
  hc: Headcount,
  opts: { names?: boolean } = {},
): string {
  const lines = [`Activity ${hc.activity_id}`];
  for (const status of Object.keys(hc.status)) {
    lines.push(
      `  ${status.padEnd(12)}${String(hc.status[status]).padStart(4)}`,
    );
    if (opts.names) {
      for (const p of hc.people) {
        if ((p.status ?? "(ukendt)") === status) {
          lines.push(`      - ${p.name ?? "(unnamed)"}`);
        }
      }
    }
  }
  lines.push(`  ${"─".repeat(16)}`);
  lines.push(`  ${"Total".padEnd(12)}${String(hc.total).padStart(4)}`);
  return lines.join("\n");
}
