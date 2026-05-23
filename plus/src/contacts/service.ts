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

export interface ContactsServiceConfig extends DavAccountConfig {
  addressBookUrl?: string;
  addressBookName?: string;
}

export interface ContactDraft {
  fullName: string;
  firstName?: string;
  lastName?: string;
  phones?: string[];
  emails?: string[];
  note?: string;
}

export interface ContactRecord extends ContactDraft {
  uid: string;
  url: string;
  etag?: string;
}

const ADDRESS_BOOK_CACHE = new Map<string, string>();

export async function listAddressBooks(config: ContactsServiceConfig): Promise<DavCollection[]> {
  const homeUrl = await resolveAddressBookHomeUrl(config);
  const xml = await propfind(
    homeUrl,
    1,
    `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
  </d:prop>
</d:propfind>`,
    config,
  );

  return listResponses(xml)
    .filter((response) => /addressbook\s*\/?>/i.test(response))
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

export async function createContact(
  draft: ContactDraft,
  config: ContactsServiceConfig,
): Promise<ContactRecord> {
  validateContactDraft(draft);

  const addressBookUrl = await resolveAddressBookUrl(config);
  const uid = randomUUID();
  const url = `${addressBookUrl.replace(/\/$/, "")}/${uid}.vcf`;
  const normalized = normalizeContactDraft(draft);
  const vcard = buildVCard(uid, normalized);
  const result = await putObject(url, "text/vcard; charset=utf-8", vcard, config, { ifNoneMatch: "*" });

  return {
    uid,
    url,
    etag: result.etag,
    ...normalized,
  };
}

export async function listContacts(
  config: ContactsServiceConfig,
  opts?: { query?: string },
): Promise<ContactRecord[]> {
  const addressBookUrl = await resolveAddressBookUrl(config);
  const xml = await report(
    addressBookUrl,
    1,
    `<?xml version="1.0" encoding="utf-8" ?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag />
    <card:address-data />
  </d:prop>
</card:addressbook-query>`,
    config,
  );

  const all = listResponses(xml)
    .map((response) => {
      const href = extractHref(response);
      const data = extractAddressData(response);
      if (!href || !data) return null;
      const parsed = parseVCard(data);
      if (!parsed) return null;
      return {
        ...parsed,
        url: resolveUrl(href, addressBookUrl),
        etag: extractEtag(response),
      };
    })
    .filter((value): value is ContactRecord => !!value);

  if (!opts?.query) return all;
  const query = opts.query.trim().toLowerCase();
  return all.filter((contact) =>
    [
      contact.fullName,
      contact.firstName ?? "",
      contact.lastName ?? "",
      ...(contact.phones ?? []),
      ...(contact.emails ?? []),
      contact.note ?? "",
    ].some((value) => value.toLowerCase().includes(query)),
  );
}

export async function updateContact(
  target: Pick<ContactRecord, "url" | "etag">,
  patch: Partial<ContactDraft>,
  config: ContactsServiceConfig,
): Promise<ContactRecord> {
  const existing = await getContact(target.url, config);
  if (!existing) {
    throw new Error("Contact not found");
  }

  const merged: ContactDraft = {
    fullName: patch.fullName ?? existing.fullName,
    firstName: patch.firstName ?? existing.firstName,
    lastName: patch.lastName ?? existing.lastName,
    phones: patch.phones ?? existing.phones,
    emails: patch.emails ?? existing.emails,
    note: patch.note ?? existing.note,
  };
  validateContactDraft(merged);

  const normalized = normalizeContactDraft(merged);
  const vcard = buildVCard(existing.uid, normalized);
  const result = await putObject(target.url, "text/vcard; charset=utf-8", vcard, config, {
    ifMatch: target.etag ?? existing.etag,
  });

  return {
    uid: existing.uid,
    url: target.url,
    etag: result.etag ?? target.etag ?? existing.etag,
    ...normalized,
  };
}

export async function deleteContact(
  target: Pick<ContactRecord, "url" | "etag">,
  config: ContactsServiceConfig,
): Promise<void> {
  await deleteObject(target.url, config, { ifMatch: target.etag });
}

export async function findContacts(query: string, config: ContactsServiceConfig): Promise<ContactRecord[]> {
  return listContacts(config, { query });
}

async function getContact(url: string, config: ContactsServiceConfig): Promise<ContactRecord | null> {
  const base = url.replace(/[^/]+$/, "");
  const xml = await report(
    base,
    1,
    `<?xml version="1.0" encoding="utf-8" ?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag />
    <card:address-data />
  </d:prop>
</card:addressbook-query>`,
    config,
  );

  for (const response of listResponses(xml)) {
    const href = extractHref(response);
    const data = extractAddressData(response);
    if (!href || !data) continue;
    const resolved = resolveUrl(href, base);
    if (resolved !== url) continue;
    const parsed = parseVCard(data);
    if (!parsed) continue;
    return {
      ...parsed,
      url: resolved,
      etag: extractEtag(response),
    };
  }
  return null;
}

async function resolveAddressBookUrl(config: ContactsServiceConfig): Promise<string> {
  if (config.addressBookUrl) return resolveUrl(config.addressBookUrl, config.discoveryUrl);

  const cacheKey = [config.discoveryUrl, config.username, config.addressBookName ?? ""].join("|");
  const cached = ADDRESS_BOOK_CACHE.get(cacheKey);
  if (cached) return cached;

  const books = await listAddressBooks(config);
  const target = config.addressBookName?.trim().toLowerCase();
  const match = target
    ? books.find((book) => book.displayName.trim().toLowerCase() === target)
    : books[0];

  if (!match) {
    throw new Error(
      config.addressBookName
        ? `Address book named ${JSON.stringify(config.addressBookName)} not found`
        : "No address book collection found",
    );
  }

  ADDRESS_BOOK_CACHE.set(cacheKey, match.url);
  return match.url;
}

async function resolveAddressBookHomeUrl(config: ContactsServiceConfig): Promise<string> {
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
    throw new Error("CardDAV discovery failed: current-user-principal not found");
  }

  const principalUrl = resolveUrl(principalHref, config.discoveryUrl);
  const homeXml = await propfind(
    principalUrl,
    0,
    `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <card:addressbook-home-set />
  </d:prop>
</d:propfind>`,
    config,
  );
  const homeHref = firstHref(homeXml, ["addressbook-home-set"]);
  if (!homeHref) {
    throw new Error("CardDAV discovery failed: addressbook-home-set not found");
  }
  return resolveUrl(homeHref, principalUrl);
}

function extractAddressData(xmlFragment: string): string | null {
  return extractPropertyText(xmlFragment, ["address-data"]);
}

function validateContactDraft(draft: ContactDraft): void {
  if (!draft.fullName.trim()) throw new Error("Contact fullName is required");
}

function normalizeContactDraft(draft: ContactDraft): ContactDraft {
  return {
    fullName: draft.fullName.trim(),
    firstName: draft.firstName?.trim() || undefined,
    lastName: draft.lastName?.trim() || undefined,
    phones: (draft.phones ?? []).map((value) => value.trim()).filter(Boolean),
    emails: (draft.emails ?? []).map((value) => value.trim()).filter(Boolean),
    note: draft.note?.trim() || undefined,
  };
}

function buildVCard(uid: string, draft: ContactDraft): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${escapeVCardText(uid)}`,
    `FN:${escapeVCardText(draft.fullName)}`,
    `N:${escapeVCardText(draft.lastName ?? "")};${escapeVCardText(draft.firstName ?? "")};;;`,
  ];

  for (const phone of draft.phones ?? []) {
    lines.push(`TEL;TYPE=CELL:${escapeVCardText(phone)}`);
  }
  for (const email of draft.emails ?? []) {
    lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardText(email)}`);
  }
  if (draft.note) lines.push(`NOTE:${escapeVCardText(draft.note)}`);

  lines.push("END:VCARD", "");
  return lines.join("\r\n");
}

function parseVCard(vcard: string): ContactRecord | null {
  const unfolded = unfoldVCardLines(vcard);
  const uid = extractVCardField(unfolded, "UID") ?? randomUUID();
  const fullName = extractVCardField(unfolded, "FN");
  if (!fullName) return null;

  const nameParts = (extractVCardField(unfolded, "N") ?? ";;;;").split(";");
  return {
    uid: unescapeVCardText(uid),
    fullName: unescapeVCardText(fullName),
    lastName: unescapeVCardText(nameParts[0] ?? ""),
    firstName: unescapeVCardText(nameParts[1] ?? ""),
    phones: extractVCardFields(unfolded, "TEL").map(unescapeVCardText),
    emails: extractVCardFields(unfolded, "EMAIL").map(unescapeVCardText),
    note: unescapeVCardText(extractVCardField(unfolded, "NOTE") ?? ""),
    url: "",
  };
}

function extractVCardField(vcard: string, field: string): string | null {
  const match = vcard.match(new RegExp(`^${field}(?:;[^:]+)?:([\\s\\S]*?)$`, "m"));
  return match?.[1] ?? null;
}

function extractVCardFields(vcard: string, field: string): string[] {
  return Array.from(vcard.matchAll(new RegExp(`^${field}(?:;[^:]+)?:([\\s\\S]*?)$`, "gm")))
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

function unfoldVCardLines(value: string): string {
  return value.replace(/\r?\n[ \t]/g, "");
}

function escapeVCardText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function unescapeVCardText(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
