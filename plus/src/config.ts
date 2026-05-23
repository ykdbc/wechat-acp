import type { CalendarServiceConfig } from "./calendar/service.js";
import type { ContactsServiceConfig } from "./contacts/service.js";
import type { MapsServiceConfig } from "./maps/service.js";

export interface PlusBotConfig {
  calendar?: CalendarServiceConfig;
  contacts?: ContactsServiceConfig;
  maps?: MapsServiceConfig;
}

export function exampleConfig(): PlusBotConfig {
  return {
    calendar: {
      username: "your-apple-id@example.com",
      password: "your-app-specific-password",
      discoveryUrl: "https://caldav.icloud.com",
      calendarName: "Home",
      defaultDurationMinutes: 60,
      defaultTimeZone: "Asia/Shanghai",
    },
    contacts: {
      username: "your-apple-id@example.com",
      password: "your-app-specific-password",
      discoveryUrl: "https://contacts.icloud.com",
      addressBookName: "Contacts",
    },
    maps: {
      defaultMapType: "m",
      defaultZoom: 16,
    },
  };
}
