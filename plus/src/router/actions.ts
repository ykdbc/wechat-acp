import type {
  CalendarEventDraft,
  CalendarEventRecord,
  CalendarServiceConfig,
} from "../calendar/service.js";
import type {
  ContactDraft,
  ContactRecord,
  ContactsServiceConfig,
} from "../contacts/service.js";
import type {
  MapLookupResult,
  MapsServiceConfig,
} from "../maps/service.js";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  findCalendarEvents,
  listCalendarEvents,
  updateCalendarEvent,
} from "../calendar/service.js";
import {
  createContact,
  deleteContact,
  findContacts,
  listContacts,
  updateContact,
} from "../contacts/service.js";
import { lookupMap } from "../maps/service.js";

export type BotAction =
  | { type: "calendar.list"; query?: string; start?: Date; end?: Date }
  | { type: "calendar.create"; draft: CalendarEventDraft }
  | { type: "calendar.update"; targetUrl: string; etag?: string; patch: Partial<CalendarEventDraft> }
  | { type: "calendar.delete"; targetUrl: string; etag?: string }
  | { type: "contact.list"; query?: string }
  | { type: "contact.create"; draft: ContactDraft }
  | { type: "contact.update"; targetUrl: string; etag?: string; patch: Partial<ContactDraft> }
  | { type: "contact.delete"; targetUrl: string; etag?: string }
  | { type: "map.lookup"; query: string };

export interface BotCapabilityConfig {
  calendar?: CalendarServiceConfig;
  contacts?: ContactsServiceConfig;
  maps?: MapsServiceConfig;
}

export type BotActionResult =
  | { type: "calendar.list"; items: CalendarEventRecord[] }
  | { type: "calendar.create"; item: CalendarEventRecord }
  | { type: "calendar.update"; item: CalendarEventRecord }
  | { type: "calendar.delete" }
  | { type: "contact.list"; items: ContactRecord[] }
  | { type: "contact.create"; item: ContactRecord }
  | { type: "contact.update"; item: ContactRecord }
  | { type: "contact.delete" }
  | { type: "map.lookup"; item: MapLookupResult };

export async function executeBotAction(
  action: BotAction,
  config: BotCapabilityConfig,
): Promise<BotActionResult> {
  switch (action.type) {
    case "calendar.list": {
      const calendar = requireCalendar(config);
      const items = action.query
        ? await findCalendarEvents(action.query, calendar, { start: action.start, end: action.end })
        : await listCalendarEvents(calendar, { start: action.start, end: action.end });
      return { type: "calendar.list", items };
    }
    case "calendar.create": {
      const item = await createCalendarEvent(action.draft, requireCalendar(config));
      return { type: "calendar.create", item };
    }
    case "calendar.update": {
      const item = await updateCalendarEvent({ url: action.targetUrl, etag: action.etag }, action.patch, requireCalendar(config));
      return { type: "calendar.update", item };
    }
    case "calendar.delete":
      await deleteCalendarEvent({ url: action.targetUrl, etag: action.etag }, requireCalendar(config));
      return { type: "calendar.delete" };
    case "contact.list": {
      const items = action.query
        ? await findContacts(action.query, requireContacts(config))
        : await listContacts(requireContacts(config));
      return { type: "contact.list", items };
    }
    case "contact.create": {
      const item = await createContact(action.draft, requireContacts(config));
      return { type: "contact.create", item };
    }
    case "contact.update": {
      const item = await updateContact({ url: action.targetUrl, etag: action.etag }, action.patch, requireContacts(config));
      return { type: "contact.update", item };
    }
    case "contact.delete":
      await deleteContact({ url: action.targetUrl, etag: action.etag }, requireContacts(config));
      return { type: "contact.delete" };
    case "map.lookup":
      return { type: "map.lookup", item: lookupMap({ query: action.query }, config.maps) };
  }
}

function requireCalendar(config: BotCapabilityConfig): CalendarServiceConfig {
  if (!config.calendar) throw new Error("Calendar capability is not configured");
  return config.calendar;
}

function requireContacts(config: BotCapabilityConfig): ContactsServiceConfig {
  if (!config.contacts) throw new Error("Contacts capability is not configured");
  return config.contacts;
}
