/**
 * Terminal presentation for the holdsport CLI.
 *
 * None of this is used by the MCP server (which returns raw JSON) — it lives
 * here purely to keep `bin/holdsport` thin. Every function is pure: it takes
 * data and returns a string.
 */

import type {
  ActivityDetail,
  ActivitySummary,
  ChatRoomDetail,
  ChatRoomSummary,
  EmailDetail,
  EmailSummary,
  RosterEntry,
} from "./client.ts";

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

/** Chat rooms as a table: id, unread, name, and a one-line last-message preview. */
export function renderChatRooms(rooms: ChatRoomSummary[]): string {
  if (rooms.length === 0) return "(no chat rooms)";
  const clip = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n - 1)}…` : s;
  const rows = rooms.map((r) => {
    const last = r.last_message;
    const preview = last
      ? `${last.author ? `${last.author.split(" ")[0]}: ` : ""}${last.text}`
      : "";
    return [
      String(r.id),
      r.unread_count > 0 ? `●${r.unread_count}` : "",
      clip(r.name || "(unnamed)", 40),
      cell(last?.time ?? ""),
      clip(preview.replace(/\s+/g, " ").trim(), 50),
    ];
  });
  const body = table(["Id", "Unread", "Name", "Last", "Preview"], rows);
  return `${body}\n\n${rooms.length} rooms`;
}

/** A chat room as a transcript: a header line then one block per message. */
export function renderChatTranscript(room: ChatRoomDetail): string {
  const header =
    `# ${room.name || "(unnamed)"}  [${room.scope}]  room ${room.id}` +
    (room.unread_count > 0 ? `  (${room.unread_count} unread)` : "");
  if (room.messages.length === 0) return `${header}\n\n(no messages)`;

  const lines = [header, ""];
  for (const m of room.messages) {
    const who = m.author || "(unknown)";
    lines.push(`[${cell(m.time)}] ${who}`);
    if (m.text) {
      for (const line of m.text.split("\n")) lines.push(`  ${line}`);
    }
    for (const url of m.images) lines.push(`  [image] ${url}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Emails as a table: id, unread marker, date, sender, attachment marker, subject. */
export function renderEmails(emails: EmailSummary[]): string {
  if (emails.length === 0) return "(no emails)";
  const clip = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n - 1)}…` : s;
  const rows = emails.map((e) => [
    String(e.id),
    e.has_been_read ? "" : "●",
    cell(e.time),
    clip(e.sender || "?", 24),
    e.has_attachments ? "@" : "",
    clip(e.subject.replace(/\s+/g, " ").trim() || "(no subject)", 50),
  ]);
  const body = table(["Id", "New", "Date", "From", "Att", "Subject"], rows);
  return `${body}\n\n${emails.length} emails`;
}

/** A single email: a header block then the body. */
export function renderEmail(email: EmailDetail): string {
  const lines = [
    `# ${email.subject || "(no subject)"}`,
    `From:  ${email.sender || "?"}`,
    `Date:  ${cell(email.time)}`,
    `To:    ${email.recipients.length} recipient${email.recipients.length === 1 ? "" : "s"}`,
  ];
  if (!email.has_been_read) lines.push("Status: unread");
  if (email.attachments.length) {
    lines.push("Attachments:");
    for (const a of email.attachments) lines.push(`  @ ${a.name}  ${a.url}`);
  }
  lines.push("", email.content || "(no content)");
  return lines.join("\n");
}

/** Rich activities as a table: id, when, type, place, sign-ups, name. */
export function renderActivities(rows: ActivitySummary[]): string {
  if (rows.length === 0) return "(no activities)";
  const clip = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n - 1)}…` : s;
  const body = table(
    ["Id", "When", "Type", "Place", "#", "Name"],
    rows.map((r) => [
      String(r.id),
      cell(r.time),
      clip(r.event_type, 16),
      clip(r.place, 18),
      String(r.attendee_count),
      (r.is_cancelled ? "✗ " : "") + clip(r.name || "(unnamed)", 30),
    ]),
  );
  return `${body}\n\n${rows.length} activities`;
}

/**
 * A rich activity: a header, a sign-up tally, and — when `names` is set — the
 * named attending / not-attending / no-answer lists.
 */
export function renderActivity(
  a: ActivityDetail,
  opts: { names?: boolean } = {},
): string {
  const when = a.end_time ? `${cell(a.time)} – ${cell(a.end_time)}` : cell(a.time);
  const lines = [
    `# ${a.name || "(unnamed)"}${a.is_cancelled ? "  (CANCELLED)" : ""}`,
    `When:  ${when}`,
    `Type:  ${a.event_type || "—"}`,
    `Place: ${a.place || "—"}`,
  ];
  if (a.comment) lines.push(`Note:  ${a.comment.replace(/\s+/g, " ").trim()}`);

  lines.push(
    "",
    `Attending:     ${a.counts.attending}  (${a.counts.players} players, ${a.counts.coaches} coaches)`,
    `Not attending: ${a.attendance.not_attending.length}`,
    `No answer:     ${a.attendance.no_answer.length}`,
  );
  if (a.waiting_list) lines.push(`Waiting list:  ${a.waiting_list}`);
  if (a.tasks) lines.push(`Tasks:         ${a.tasks}`);

  if (opts.names) {
    const block = (label: string, names: string[]) => {
      if (names.length === 0) return;
      lines.push("", `${label} (${names.length}):`);
      for (const n of names) lines.push(`  - ${n}`);
    };
    block("Attending — players", a.attendance.attending_players);
    block("Attending — coaches", a.attendance.attending_coaches);
    block("Not attending", a.attendance.not_attending);
    block("No answer", a.attendance.no_answer);
  }
  return lines.join("\n");
}
