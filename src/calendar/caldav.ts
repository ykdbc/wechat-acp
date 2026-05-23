import { randomUUID } from "node:crypto";

export interface CalendarIntegrationConfig {
  enabled: boolean;
  provider: "caldav";
  discoveryUrl: string;
  calendarUrl?: string;
  username: string;
  password: string;
  calendarName?: string;
  defaultDurationMinutes: number;
  defaultTimeZone: string;
}

export interface CalendarCreateDraft {
  title: string;
  start: CalendarMoment;
  end?: CalendarMoment;
  location?: string;
  notes?: string;
  reminderMinutesBefore?: number;
}

export interface CalendarMoment {
  kind: "date" | "date-time";
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

export interface CalendarCreateResult {
  uid: string;
  calendarUrl: string;
  eventUrl: string;
}

interface NormalizedCalendarCreateDraft {
  title: string;
  start: CalendarMoment;
  end: CalendarMoment;
  location: string;
  notes: string;
  reminderMinutesBefore?: number;
}

const DISCOVERY_CACHE = new Map<string, string>();

export async function createCalendarEvent(
  draft: CalendarCreateDraft,
  config: CalendarIntegrationConfig,
  log: (msg: string) => void,
): Promise<CalendarCreateResult> {
  if (!config.username || !config.password) {
    throw new Error("Calendar credentials are not configured");
  }

  const calendarUrl = await resolveCalendarUrl(config, log);
  const uid = randomUUID();
  const objectUrl = `${calendarUrl.replace(/\/$/, "")}/${uid}.ics`;
  const event = normalizeDraft(draft, config.defaultDurationMinutes);
  const body = buildVEvent(uid, event, config.defaultTimeZone);

  log(`Creating calendar event in ${calendarUrl}: ${event.title}`);

  const response = await fetch(objectUrl, {
    method: "PUT",
    headers: {
      Authorization: basicAuth(config.username, config.password),
      "Content-Type": "text/calendar; charset=utf-8",
      "If-None-Match": "*",
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Calendar event creation failed: HTTP ${response.status}: ${compact(text)}`);
  }

  return {
    uid,
    calendarUrl,
    eventUrl: objectUrl,
  };
}

async function resolveCalendarUrl(
  config: CalendarIntegrationConfig,
  log: (msg: string) => void,
): Promise<string> {
  if (config.calendarUrl) return normalizeUrl(config.calendarUrl, config.discoveryUrl);

  const cacheKey = [config.discoveryUrl, config.username, config.calendarName ?? ""].join("|");
  const cached = DISCOVERY_CACHE.get(cacheKey);
  if (cached) return cached;

  log("Discovering CalDAV calendar collection URL");

  const principalText = await propfind(
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

  const principalHref = firstHref(principalText, ["current-user-principal", "principal-URL"]);
  if (!principalHref) {
    throw new Error("CalDAV discovery failed: current-user-principal not found");
  }

  const principalUrl = normalizeUrl(principalHref, config.discoveryUrl);
  const homeText = await propfind(
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

  const calendarHomeHref = firstHref(homeText, ["calendar-home-set"]);
  if (!calendarHomeHref) {
    throw new Error("CalDAV discovery failed: calendar-home-set not found");
  }

  const calendarHomeUrl = normalizeUrl(calendarHomeHref, principalUrl);
  const collectionsText = await propfind(
    calendarHomeUrl,
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

  const calendarUrl = selectCalendarCollection(collectionsText, calendarHomeUrl, config.calendarName);
  if (!calendarUrl) {
    throw new Error(
      config.calendarName
        ? `CalDAV discovery failed: calendar named ${JSON.stringify(config.calendarName)} not found`
        : "CalDAV discovery failed: no calendar collection found",
    );
  }

  DISCOVERY_CACHE.set(cacheKey, calendarUrl);
  return calendarUrl;
}

async function propfind(
  url: string,
  depth: 0 | 1,
  body: string,
  config: CalendarIntegrationConfig,
): Promise<string> {
  const response = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(config.username, config.password),
      Depth: String(depth),
      "Content-Type": 'application/xml; charset="utf-8"',
    },
    body,
  });

  const text = await response.text();
  if (response.status === 401) {
    throw new Error("CalDAV authentication failed: check Apple ID and app-specific password");
  }
  if (response.status !== 207 && !response.ok) {
    throw new Error(`CalDAV request failed: HTTP ${response.status}: ${compact(text)}`);
  }
  return text;
}

function normalizeDraft(
  draft: CalendarCreateDraft,
  defaultDurationMinutes: number,
): NormalizedCalendarCreateDraft {
  const start = draft.start;
  const end = draft.end ?? inferEnd(start, defaultDurationMinutes);
  const reminderMinutesBefore = draft.reminderMinutesBefore;
  return {
    title: draft.title,
    start,
    end,
    location: draft.location ?? "",
    notes: draft.notes ?? "",
    ...(reminderMinutesBefore !== undefined ? { reminderMinutesBefore } : {}),
  };
}

function inferEnd(start: CalendarMoment, defaultDurationMinutes: number): CalendarMoment {
  if (start.kind === "date") {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day));
    date.setUTCDate(date.getUTCDate() + 1);
    return {
      kind: "date",
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }

  const date = new Date(Date.UTC(
    start.year,
    start.month - 1,
    start.day,
    start.hour ?? 0,
    start.minute ?? 0,
  ));
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

function buildVEvent(
  uid: string,
  draft: NormalizedCalendarCreateDraft,
  timeZone: string,
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//wechat-acp//iCloud Calendar Bridge//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatUtcStamp(new Date())}`,
    formatDateLine("DTSTART", draft.start, timeZone),
    formatDateLine("DTEND", draft.end, timeZone),
    `SUMMARY:${escapeIcsText(draft.title)}`,
  ];

  if (draft.location) lines.push(`LOCATION:${escapeIcsText(draft.location)}`);
  if (draft.notes) lines.push(`DESCRIPTION:${escapeIcsText(draft.notes)}`);
  if (draft.reminderMinutesBefore && draft.reminderMinutesBefore > 0) {
    lines.push(
      "BEGIN:VALARM",
      `TRIGGER:${formatReminderTrigger(draft.reminderMinutesBefore)}`,
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcsText(draft.title)}`,
      "END:VALARM",
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

function formatDateLine(field: string, value: CalendarMoment, timeZone: string): string {
  if (value.kind === "date") {
    return `${field};VALUE=DATE:${formatDate(value)}`;
  }
  return `${field};TZID=${timeZone}:${formatDateTime(value)}`;
}

function formatDate(value: CalendarMoment): string {
  return `${pad(value.year, 4)}${pad(value.month, 2)}${pad(value.day, 2)}`;
}

function formatDateTime(value: CalendarMoment): string {
  return `${formatDate(value)}T${pad(value.hour ?? 0, 2)}${pad(value.minute ?? 0, 2)}00`;
}

function formatUtcStamp(date: Date): string {
  return [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1, 2),
    pad(date.getUTCDate(), 2),
    "T",
    pad(date.getUTCHours(), 2),
    pad(date.getUTCMinutes(), 2),
    pad(date.getUTCSeconds(), 2),
    "Z",
  ].join("");
}

function firstHref(xml: string, propertyNames: string[]): string | null {
  for (const name of propertyNames) {
    const regex = new RegExp(`<[^>]*${escapeRegex(name)}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)</[^>]*href>`, "i");
    const match = xml.match(regex);
    if (match?.[1]) return decodeXml(match[1].trim());
  }
  return null;
}

function selectCalendarCollection(xml: string, baseUrl: string, calendarName?: string): string | null {
  const responseRegex = /<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi;
  const responses = Array.from(xml.matchAll(responseRegex));
  const normalizedTarget = calendarName?.trim().toLowerCase();
  let fallback: string | null = null;

  for (const response of responses) {
    const body = response[1] ?? "";
    if (!/calendar\s*\/?>/i.test(body)) continue;

    const hrefMatch = body.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i);
    if (!hrefMatch?.[1]) continue;

    const displayNameMatch = body.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname>/i);
    const displayName = decodeXml(displayNameMatch?.[1]?.trim() ?? "");
    const url = normalizeUrl(decodeXml(hrefMatch[1].trim()), baseUrl);

    if (!fallback) fallback = url;
    if (normalizedTarget && displayName.toLowerCase() === normalizedTarget) {
      return url;
    }
  }

  return fallback;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function normalizeUrl(value: string, base: string): string {
  return new URL(value, ensureTrailingSlash(base)).toString();
}

function ensureTrailingSlash(url: string): string {
  return /\/$/.test(url) ? url : `${url}/`;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function formatReminderTrigger(minutesBefore: number): string {
  if (minutesBefore % 1440 === 0) {
    return `-P${minutesBefore / 1440}D`;
  }
  if (minutesBefore % 60 === 0) {
    return `-PT${minutesBefore / 60}H`;
  }
  return `-PT${minutesBefore}M`;
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pad(value: number, size: number): string {
  return String(value).padStart(size, "0");
}
