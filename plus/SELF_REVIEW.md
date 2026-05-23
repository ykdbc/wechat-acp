# Self Review

## What looks solid

- `src/dav/client.ts`
  - Shared DAV request helpers are separated from calendar/contact logic.
- `src/calendar/service.ts`
  - Supports collection discovery plus event list/create/update/delete.
  - Added basic validation for invalid dates and end-before-start.
- `src/contacts/service.ts`
  - Supports address book discovery plus contact list/create/update/delete.
- `src/maps/service.ts`
  - Uses Apple Maps link format, which is a low-risk integration path for bot replies.
- `src/router/actions.ts`
  - Keeps the execution path for the three capabilities consistent.

## Intentional limitations

- Natural-language delete/update is not executed directly.
  - The current parser maps those messages to lookup actions first.
  - This is intentional to avoid accidental destructive operations.
- Map support is currently “return Apple Maps link”.
  - It does not geocode to coordinates server-side.
  - It does not render static snapshots yet.
- Calendar natural-language parsing is still narrow.
  - Structured command formats are much more reliable than free text right now.

## Risks and follow-up work

- DAV XML parsing is regex-based.
  - Good enough for a first pass, but still brittle against unusual server responses.
- ICS/vCard parsing is partial.
  - Complex recurrence, alarms, attendees, rich contact fields, and folded edge cases are not fully covered.
- No live iCloud verification was possible in this environment.
  - The code is implementation-ready, but not production-proven.
- No local build was run here.
  - This machine session did not have a runnable `node` / `npm` in PATH when checked earlier.
