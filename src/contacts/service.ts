import { randomUUID } from "node:crypto";

export interface ContactsIntegrationConfig {
  enabled: boolean;
  discoveryUrl: string;
  addressBookUrl?: string;
  addressBookName?: string;
  username: string;
  password: string;
}

export interface ContactDraft {
  fullName: string;
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

export async function findContacts(
  query: string,
  config: ContactsIntegrationConfig,
): Promise<ContactRecord[]> {
  const all = await listContacts(config);
  const normalized = query.trim().toLowerCase();
  return all.filter((contact) => {
    const haystack = [
      contact.fullName,
      ...(contact.phones ?? []),
      ...(contact.emails ?? []),
      contact.note ?? "",
    ].join("\n").toLowerCase();
    return haystack.includes(normalized);
  });
}

export async function createContact(
  draft: ContactDraft,
  config: ContactsIntegrationConfig,
): Promise<ContactRecord> {
  ensureCredentials(config);
  if (!draft.fullName.trim()) {
    throw new Error("联系人姓名不能为空");
  }

  const addressBookUrl = await resolveAddressBookUrl(config);
  const uid = randomUUID();
  const objectUrl = `${addressBookUrl.replace(/\/$/, "")}/${uid}.vcf`;
  const vcard = buildVCard(uid, draft);

  const response = await fetch(objectUrl, {
    method: "PUT",
    headers: {
      Authorization: basicAuth(config.username, config.password),
      "Content-Type": "text/vcard; charset=utf-8",
      "If-None-Match": "*",
    },
    body: vcard,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`联系人创建失败：HTTP ${response.status}: ${compact(text)}`);
  }

  return {
    uid,
    url: objectUrl,
    etag: response.headers.get("etag") ?? undefined,
    fullName: draft.fullName.trim(),
    phones: normalizedList(draft.phones),
    emails: normalizedList(draft.emails),
    note: draft.note?.trim() || undefined,
  };
}

export async function deleteContact(
  contact: Pick<ContactRecord, "url" | "etag">,
  config: ContactsIntegrationConfig,
): Promise<void> {
  ensureCredentials(config);
  const response = await fetch(contact.url, {
    method: "DELETE",
    headers: {
      Authorization: basicAuth(config.username, config.password),
      ...(contact.etag ? { "If-Match": contact.etag } : {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`联系人删除失败：HTTP ${response.status}: ${compact(text)}`);
  }
}

export async function listContacts(config: ContactsIntegrationConfig): Promise<ContactRecord[]> {
  ensureCredentials(config);
  const addressBookUrl = await resolveAddressBookUrl(config);
  const xml = await report(
    addressBookUrl,
    `<?xml version="1.0" encoding="utf-8" ?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag />
    <card:address-data />
  </d:prop>
</card:addressbook-query>`,
    config,
  );

  const responses = Array.from(xml.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi));
  return responses
    .map((match) => parseContactResponse(match[1] ?? "", addressBookUrl))
    .filter((value): value is ContactRecord => !!value);
}

async function resolveAddressBookUrl(config: ContactsIntegrationConfig): Promise<string> {
  if (config.addressBookUrl) return normalizeUrl(config.addressBookUrl, config.discoveryUrl);

  const cacheKey = [config.discoveryUrl, config.username, config.addressBookName ?? ""].join("|");
  const cached = ADDRESS_BOOK_CACHE.get(cacheKey);
  if (cached) return cached;

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
    throw new Error("通讯录发现失败：current-user-principal not found");
  }

  const principalUrl = normalizeUrl(principalHref, config.discoveryUrl);
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
    throw new Error("通讯录发现失败：addressbook-home-set not found");
  }

  const addressBookHomeUrl = normalizeUrl(homeHref, principalUrl);
  const collectionsXml = await propfind(
    addressBookHomeUrl,
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

  const responses = Array.from(collectionsXml.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi));
  const targetName = config.addressBookName?.trim().toLowerCase();
  let fallback: string | null = null;
  for (const response of responses) {
    const body = response[1] ?? "";
    if (!/addressbook\s*\/?>/i.test(body)) continue;
    const href = extractHref(body);
    if (!href) continue;
    const displayName = extractDisplayName(body);
    const url = normalizeUrl(href, addressBookHomeUrl);
    if (!fallback) fallback = url;
    if (targetName && displayName.toLowerCase() === targetName) {
      ADDRESS_BOOK_CACHE.set(cacheKey, url);
      return url;
    }
  }

  if (!fallback) {
    throw new Error("通讯录发现失败：未找到 address book");
  }
  ADDRESS_BOOK_CACHE.set(cacheKey, fallback);
  return fallback;
}

async function propfind(
  url: string,
  depth: number,
  body: string,
  config: ContactsIntegrationConfig,
): Promise<string> {
  const response = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(config.username, config.password),
      Depth: String(depth),
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });
  const text = await response.text();
  if (response.status === 401) {
    throw new Error("通讯录认证失败：请检查 Apple 账号和 app 专用密码");
  }
  if (response.status !== 207 && !response.ok) {
    throw new Error(`通讯录请求失败：HTTP ${response.status}: ${compact(text)}`);
  }
  return text;
}

async function report(
  url: string,
  body: string,
  config: ContactsIntegrationConfig,
): Promise<string> {
  const response = await fetch(url, {
    method: "REPORT",
    headers: {
      Authorization: basicAuth(config.username, config.password),
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body,
  });
  const text = await response.text();
  if (response.status === 401) {
    throw new Error("通讯录认证失败：请检查 Apple 账号和 app 专用密码");
  }
  if (response.status !== 207 && !response.ok) {
    throw new Error(`通讯录查询失败：HTTP ${response.status}: ${compact(text)}`);
  }
  return text;
}

function parseContactResponse(xmlFragment: string, baseUrl: string): ContactRecord | null {
  const href = extractHref(xmlFragment);
  const addressDataMatch = xmlFragment.match(/<[^>]*address-data[^>]*>([\s\S]*?)<\/[^>]*address-data>/i);
  if (!href || !addressDataMatch?.[1]) return null;

  const vcard = decodeXml(addressDataMatch[1]);
  const fullName = firstVCardField(vcard, "FN");
  if (!fullName) return null;

  return {
    uid: firstVCardField(vcard, "UID") ?? randomUUID(),
    url: normalizeUrl(href, baseUrl),
    etag: extractEtag(xmlFragment),
    fullName,
    phones: allVCardFields(vcard, "TEL"),
    emails: allVCardFields(vcard, "EMAIL"),
    note: firstVCardField(vcard, "NOTE") ?? undefined,
  };
}

function buildVCard(uid: string, draft: ContactDraft): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${escapeVCardText(uid)}`,
    `FN:${escapeVCardText(draft.fullName.trim())}`,
    `N:${escapeVCardText(draft.fullName.trim())};;;;`,
  ];
  for (const phone of normalizedList(draft.phones)) {
    lines.push(`TEL;TYPE=CELL:${escapeVCardText(phone)}`);
  }
  for (const email of normalizedList(draft.emails)) {
    lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardText(email)}`);
  }
  if (draft.note?.trim()) {
    lines.push(`NOTE:${escapeVCardText(draft.note.trim())}`);
  }
  lines.push("END:VCARD", "");
  return lines.join("\r\n");
}

function normalizedList(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function firstVCardField(vcard: string, field: string): string | null {
  const unfolded = vcard.replace(/\r?\n[ \t]/g, "");
  const match = unfolded.match(new RegExp(`^${field}(?:;[^:]+)?:([^\\r\\n]+)$`, "mi"));
  return match?.[1]?.trim() || null;
}

function allVCardFields(vcard: string, field: string): string[] {
  const unfolded = vcard.replace(/\r?\n[ \t]/g, "");
  return Array.from(unfolded.matchAll(new RegExp(`^${field}(?:;[^:]+)?:([^\\r\\n]+)$`, "gmi")))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function firstHref(xml: string, propertyNames: string[]): string | null {
  for (const name of propertyNames) {
    const regex = new RegExp(`<[^>]*${escapeRegex(name)}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)</[^>]*href>`, "i");
    const match = xml.match(regex);
    if (match?.[1]) return decodeXml(match[1].trim());
  }
  return null;
}

function extractHref(xmlFragment: string): string | null {
  const match = xmlFragment.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i);
  return match?.[1] ? decodeXml(match[1].trim()) : null;
}

function extractDisplayName(xmlFragment: string): string {
  const match = xmlFragment.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname>/i);
  return decodeXml(match?.[1]?.trim() ?? "");
}

function extractEtag(xmlFragment: string): string | undefined {
  const match = xmlFragment.match(/<[^>]*getetag[^>]*>([^<]+)<\/[^>]*getetag>/i);
  return match?.[1] ? decodeXml(match[1].trim()) : undefined;
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

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#13;/g, "\r")
    .replace(/&#10;/g, "\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeVCardText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 400);
}

function ensureCredentials(config: ContactsIntegrationConfig): void {
  if (!config.username || !config.password) {
    throw new Error("通讯录凭据未配置");
  }
}
