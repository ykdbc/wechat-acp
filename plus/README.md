This directory contains the calendar-related changes that were written into
`/opt/WeiXinBot/wechat-acp`, extracted for review without further modifying the
original project files.

Contents:

- `wechat-acp-calendar.patch`: combined patch for the original repo changes
- `src/calendar/caldav.ts`: extracted CalDAV/iCloud calendar writer
- `src/calendar/intent.ts`: extracted calendar command parser
- `src/calendar/service.ts`: CalDAV CRUD service
- `src/contacts/service.ts`: CardDAV CRUD service
- `src/maps/service.ts`: Apple Maps link service
- `src/router/actions.ts`: unified action execution
- `src/router/intent.ts`: natural-language action parsing
- `src/config.ts`: unified config example

The patch targets files under `/opt/WeiXinBot/wechat-acp`.
