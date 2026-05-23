import { randomUUID } from "node:crypto";
import {
  deleteObject,
  extractDisplayName,
  extractEtag,
  extractHref,
  extractPropertyText,
  firstHref,
  listResponses,
  propfind,
  putObject,
  report,
  resolveUrl,
  type DavAccountConfig,
  type DavCollection,
} from "../dav/client.js";

export interface CalendarServiceConfig extends DavAccountConfig {
  calendarUrl?: string;
  calendarName?: string;
  defaultDurationMinutes: number;
  defaultTimeZone: string;
}

export interface CalendarMoment {
  kind: "date" | "date-time";
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

export interface CalendarEventDraft {
  title: string;
  start: CalendarMoment;
  end?: CalendarMoment;
  location?: string;
  notes?: string;
}

export interface CalendarEventRecord extends CalendarEventDraft {
  uid: string;
  url: string;
  etag?: string;
}

const CALENDAR_CACHE = new Map<string, string>();

export async function listCalendars(config: CalendarServiceConfig): Promise<DavCollection[]> {
  const homeUrl = await resolveCalendarHomeUrl(config);
  const xml = await propfind(
    homeUrl,
    1,
    `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
  </d:prop>
</d:propfind>`,
    config,
  );

  return listResponses(xml)
    .filter((response) => /calendar\s*\/?>/i.test(response))
    .map((response) => {
      const href = extractHref(response);
      if (!href) return null;
      return {
        url: resolveUrl(href, homeUrl),
        displayName: extractDisplayName(response),
      };
    })
    .filter((value): value is DavCollection => !!value);
}

export async function createCalendarEvent(
  draft: CalendarEventDraft,
  config: CalendarServiceConfig,
): Promise<CalendarEventRecord> {
  validateDraft(draft, config.defaultDurationMinutes);

  const calendarUrl = await resolveCalendarUrl(config);
  const uid = randomUUID();
  const url = `${calendarUrl.replace(/\/$/, "")}/${uid}.ics`;
  const normalized = normalizeDraft(draft, config.defaultDurationMinutes);
  const ics = buildVEvent(uid, normalized, config.defaultTimeZone);
  const result = await putObject(url, "text/calendar; charset=utf-8", ics, config, { ifNoneMatch: "*" });

  return {
    uid,
    url,
    etag: result.etag,
    ...normalized,
  };
}

export async function listCalendarEvents(
  config: CalendarServiceConfig,
  opts?: { start?: Date; end?: Date; keyword?: string },
): Promise<CalendarEventRecord[]> {
  const calendarUrl = await resolveCalendarUrl(config);
  const timeFilter = opts?.start || opts?.end
    ? `<c:time-range${opts?.start ? ` start="${formatUtcForQuery(opts.start)}"` : ""}${opts?.end ? ` end="${formatUtcForQuery(opts.end)}"` : ""} />`
    : "";

  const xml = await report(
    calendarUrl,
    1,
    `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        ${timeFilter}
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
    config,
  );

  const all = listResponses(xml)
    .map((response) => {
      const href = extractHref(response);
      const data = extractCalendarData(response);
      if (!href || !data) return null;
      const parsed = parseVEvent(data);
      if (!parsed) return null;
      return {
        ...parsed,
        url: resolveUrl(href, calendarUrl),
        etag: extractEtag(response),
      };
    })
    .filter((value): value is CalendarEventRecord => !!value);

  if (!opts?.keyword) return all;
  const keyword = opts.keyword.trim().toLowerCase();
  return all.filter((event) =>
    [
      event.title,
      event.location ?? "",
      event.notes ?? "",
    ].some((field) => field.toLowerCase().includes(keyword)),
  );
}

export async function updateCalendarEvent(
  target: Pick<CalendarEventRecord, "url" | "etag">,
  patch: Partial<CalendarEventDraft>,
  config: CalendarServiceConfig,
): Promise<CalendarEventRecord> {
  const existing = await getCalendarEvent(target.url, config);
  if (!existing) {
    throw new Error("Calendar event not found");
  }

  const merged: CalendarEventDraft = {
    title: patch.title ?? existing.title,
    start: patch.start ?? existing.start,
    end: patch.end ?? existing.end,
    location: patch.location ?? existing.location,
    notes: patch.notes ?? existing.notes,
  };
  validateDraft(merged, config.defaultDurationMinutes);

  const normalized = normalizeDraft(merged, config.defaultDurationMinutes);
  const ics = buildVEvent(existing.uid, normalized, config.defaultTimeZone);
  const result = await putObject(target.url, "text/calendar; charset=utf-8", ics, config, {
    ifMatch: target.etag ?? existing.etag,
  });

  return {
    uid: existing.uid,
    url: target.url,
    etag: result.etag ?? target.etag ?? existing.etag,
    ...normalized,
  };
}

export async function deleteCalendarEvent(
  target: Pick<CalendarEventRecord, "url" | "etag">,
  config: CalendarServiceConfig,
): Promise<void> {
  await deleteObject(target.url, config, { ifMatch: target.etag });
}

export async function findCalendarEvents(
  query: string,
  config: CalendarServiceConfig,
  opts?: { start?: Date; end?: Date },
): Promise<CalendarEventRecord[]> {
  return listCalendarEvents(config, { ...opts, keyword: query });
}

async function getCalendarEvent(url: string, config: CalendarServiceConfig): Promise<CalendarEventRecord | null> {
  const base = url.replace(/[^/]+$/, "");
  const xml = await report(
    base,
    1,
    `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT" />
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
    config,
  );

  for (const response of listResponses(xml)) {
    const href = extractHref(response);
    const data = extractCalendarData(response);
    if (!href || !data) continue;
    const resolved = resolveUrl(href, base);
    if (resolved !== url) continue;
    const parsed = parseVEvent(data);
    if (!parsed) continue;
    return {
      ...parsed,
      url: resolved,
      etag: extractEtag(response),
    };
  }

  return null;
}

async function resolveCalendarUrl(config: CalendarServiceConfig): Promise<string> {
  if (config.calendarUrl) return resolveUrl(config.calendarUrl, config.discoveryUrl);

  const cacheKey = [config.discoveryUrl, config.username, config.calendarName ?? ""].join("|");
  const cached = CALENDAR_CACHE.get(cacheKey);
  if (cached) return cached;

  const calendars = await listCalendars(config);
  const target = config.calendarName?.trim().toLowerCase();
  const match = target
    ? calendars.find((calendar) => calendar.displayName.trim().toLowerCase() === target)
    : calendars[0];

  if (!match) {
    throw new Error(
      config.calendarName
        ? `Calendar named ${JSON.stringify(config.calendarName)} not found`
        : "No calendar collection found",
    );
  }

  CALENDAR_CACHE.set(cacheKey, match.url);
  return match.url;
}

async function resolveCalendarHomeUrl(config: CalendarServiceConfig): Promise<string> {
  const principalXml = await propfind(
    config.discoveryUrl,
    0,
    `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal />
    <d:principal-URL />
  </d:prop>
</d:propfind>`,
    config,
  );

  const principalHref = firstHref(principalXml, ["current-user-principal", "principal-URL"]);
  if (!principalHref) {
    throw new Error("CalDAV discovery failed: current-user-principal not found");
  }

  const principalUrl = resolveUrl(principalHref, config.discoveryUrl);
  const homeXml = await propfind(
    principalUrl,
    0,
    `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set />
  </d:prop>
</d:propfind>`,
    config,
  );

  const homeHref = firstHref(homeXml, ["calendar-home-set"]);
  if (!homeHref) {
    throw new Error("CalDAV discovery failed: calendar-home-set not found");
  }
  return resolveUrl(homeHref, principalUrl);
}

function extractCalendarData(xmlFragment: string): string | null {
  return extractPropertyText(xmlFragment, ["calendar-data"]);
}

function validateDraft(draft: CalendarEventDraft, defaultDurationMinutes: number): void {
  if (!draft.title.trim()) throw new Error("Calendar event title is required");
  validateMoment(draft.start);
  if (draft.end) validateMoment(draft.end);

  const normalized = normalizeDraft(draft, defaultDurationMinutes);
  if (compareMoments(normalized.end, normalized.start) <= 0) {
    throw new Error("Calendar event end must be later than start");
  }
}

function validateMoment(value: CalendarMoment): void {
  if (value.month < 1 || value.month > 12) throw new Error("Invalid month");
  if (value.day < 1 || value.day > 31) throw new Error("Invalid day");
  if (value.kind === "date-time") {
    if ((value.hour ?? -1) < 0 || (value.hour ?? 99) > 23) throw new Error("Invalid hour");
    if ((value.minute ?? -1) < 0 || (value.minute ?? 99) > 59) throw new Error("Invalid minute");
  }

  const date = new Date(Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.kind === "date-time" ? value.hour ?? 0 : 0,
    value.kind === "date-time" ? value.minute ?? 0 : 0,
  ));
  if (
    date.getUTCFullYear() !== value.year ||
    date.getUTCMonth() + 1 !== value.month ||
    date.getUTCDate() !== value.day
  ) {
    throw new Error("Invalid calendar date");
  }
}

function normalizeDraft(draft: CalendarEventDraft, defaultDurationMinutes: number): Required<CalendarEventDraft> {
  return {
    title: draft.title.trim(),
    start: draft.start,
    end: draft.end ?? inferEnd(draft.start, defaultDurationMinutes),
    location: draft.location?.trim() ?? "",
    notes: draft.notes?.trim() ?? "",
  };
}

function inferEnd(start: CalendarMoment, defaultDurationMinutes: number): CalendarMoment {
  if (start.kind === "date") {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day));
    date.setUTCDate(date.getUTCDate() + 1);
    return { kind: "date", year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }

  const date = toUtcDate(start);
  date.setUTCMinutes(date.getUTCMinutes() + defaultDurationMinutes);
  return {
    kind: "date-time",
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function buildVEvent(uid: string, draft: Required<CalendarEventDraft>, timeZone: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WeiXinBot Plus//CalDAV Calendar Bridge//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatUtcForIcs(new Date())}`,
    formatDateLine("DTSTART", draft.start, timeZone),
    formatDateLine("DTEND", draft.end, timeZone),
    `SUMMARY:${escapeIcsText(draft.title)}`,
  ];
  if (draft.location) lines.push(`LOCATION:${escapeIcsText(draft.location)}`);
  if (draft.notes) lines.push(`DESCRIPTION:${escapeIcsText(draft.notes)}`);
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

function parseVEvent(ics: string): CalendarEventRecord | null {
  const uid = extractIcsField(ics, "UID");
  const title = extractIcsField(ics, "SUMMARY");
  const startLine = extractIcsLine(ics, "DTSTART");
  const endLine = extractIcsLine(ics, "DTEND");
  if (!uid || !title || !startLine || !endLine) return null;

  const start = parseIcsMoment(startLine);
  const end = parseIcsMoment(endLine);
  if (!start || !end) return null;

  return {
    uid,
    title: unescapeIcsText(title),
    start,
    end,
    location: unescapeIcsText(extractIcsField(ics, "LOCATION") ?? ""),
    notes: unescapeIcsText(extractIcsField(ics, "DESCRIPTION") ?? ""),
    url: "",
  };
}

function extractIcsField(ics: string, field: string): string | null {
  const line = extractIcsLine(ics, field);
  if (!line) return null;
  const index = line.indexOf(":");
  return index >= 0 ? line.slice(index + 1) : null;
}

function extractIcsLine(ics: string, field: string): string | null {
  const normalized = unfoldIcsLines(ics);
  const match = normalized.match(new RegExp(`^${field}(?:;[^:]+)?:.*$`, "m"));
  return match?.[0] ?? null;
}

function parseIcsMoment(line: string): CalendarMoment | null {
  const [, params = "", raw = ""] = line.match(/^[A-Z]+((?:;[^:]+)*)?:(.+)$/) ?? [];
  if (!raw) return null;
  if (/VALUE=DATE/i.test(params)) {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) return null;
    return { kind: "date", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return null;
  return {
    kind: "date-time",
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

function formatDateLine(field: string, value: CalendarMoment, timeZone: string): string {
  if (value.kind === "date") return `${field};VALUE=DATE:${formatDate(value)}`;
  return `${field};TZID=${timeZone}:${formatDateTime(value)}`;
}

function compareMoments(a: CalendarMoment, b: CalendarMoment): number {
  const left = a.kind === "date" ? Date.UTC(a.year, a.month - 1, a.day) : toUtcDate(a).getTime();
  const right = b.kind === "date" ? Date.UTC(b.year, b.month - 1, b.day) : toUtcDate(b).getTime();
  return left - right;
}

function toUtcDate(value: CalendarMoment): Date {
  return new Date(Date.UTC(value.year, value.month - 1, value.day, value.hour ?? 0, value.minute ?? 0));
}

function formatDate(value: CalendarMoment): string {
  return `${pad(value.year, 4)}${pad(value.month, 2)}${pad(value.day, 2)}`;
}

function formatDateTime(value: CalendarMoment): string {
  return `${formatDate(value)}T${pad(value.hour ?? 0, 2)}${pad(value.minute ?? 0, 2)}00`;
}

function formatUtcForIcs(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}Z`;
}

function formatUtcForQuery(date: Date): string {
  return formatUtcForIcs(date);
}

function unfoldIcsLines(value: string): string {
  return value.replace(/\r?\n[ \t]/g, "");
}

function escapeIcsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function unescapeIcsText(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
