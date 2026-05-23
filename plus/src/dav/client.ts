export interface DavAccountConfig {
  username: string;
  password: string;
  discoveryUrl: string;
}

export interface DavCollection {
  url: string;
  displayName: string;
}

export interface DavObject {
  url: string;
  etag?: string;
  data: string;
}

export async function propfind(
  url: string,
  depth: number,
  body: string,
  config: DavAccountConfig,
): Promise<string> {
  return requestText(url, "PROPFIND", config, {
    Depth: String(depth),
    "Content-Type": "application/xml; charset=utf-8",
  }, body, [207]);
}

export async function report(
  url: string,
  depth: number,
  body: string,
  config: DavAccountConfig,
): Promise<string> {
  return requestText(url, "REPORT", config, {
    Depth: String(depth),
    "Content-Type": "application/xml; charset=utf-8",
  }, body, [207]);
}

export async function putObject(
  url: string,
  contentType: string,
  body: string,
  config: DavAccountConfig,
  opts?: { ifNoneMatch?: string; ifMatch?: string },
): Promise<{ etag?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
  };
  if (opts?.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
  if (opts?.ifMatch) headers["If-Match"] = opts.ifMatch;

  const response = await request(url, "PUT", config, headers, body);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`DAV PUT failed: HTTP ${response.status}: ${compact(text)}`);
  }
  return { etag: response.headers.get("etag") ?? undefined };
}

export async function deleteObject(
  url: string,
  config: DavAccountConfig,
  opts?: { ifMatch?: string },
): Promise<void> {
  const headers: Record<string, string> = {};
  if (opts?.ifMatch) headers["If-Match"] = opts.ifMatch;

  const response = await request(url, "DELETE", config, headers);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`DAV DELETE failed: HTTP ${response.status}: ${compact(text)}`);
  }
}

export function firstHref(xml: string, propertyNames: string[]): string | null {
  for (const name of propertyNames) {
    const regex = new RegExp(`<[^>]*${escapeRegex(name)}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)</[^>]*href>`, "i");
    const match = xml.match(regex);
    if (match?.[1]) return decodeXml(match[1].trim());
  }
  return null;
}

export function listResponses(xml: string): string[] {
  return Array.from(xml.matchAll(/<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi))
    .map((match) => match[1] ?? "");
}

export function extractHref(xmlFragment: string): string | null {
  const match = xmlFragment.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i);
  return match?.[1] ? decodeXml(match[1].trim()) : null;
}

export function extractDisplayName(xmlFragment: string): string {
  const match = xmlFragment.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname>/i);
  return decodeXml(match?.[1]?.trim() ?? "");
}

export function extractEtag(xmlFragment: string): string | undefined {
  const match = xmlFragment.match(/<[^>]*getetag[^>]*>([^<]+)<\/[^>]*getetag>/i);
  return match?.[1] ? decodeXml(match[1].trim()) : undefined;
}

export function extractPropertyText(xmlFragment: string, propertyNames: string[]): string | null {
  for (const name of propertyNames) {
    const regex = new RegExp(`<[^>]*${escapeRegex(name)}[^>]*>([\\s\\S]*?)</[^>]*${escapeRegex(name)}[^>]*>`, "i");
    const match = xmlFragment.match(regex);
    if (match?.[1]) return decodeXml(match[1].trim());
  }
  return null;
}

export function resolveUrl(value: string, base: string): string {
  return new URL(value, ensureTrailingSlash(base)).toString();
}

export function ensureTrailingSlash(url: string): string {
  return /\/$/.test(url) ? url : `${url}/`;
}

async function requestText(
  url: string,
  method: string,
  config: DavAccountConfig,
  headers: Record<string, string>,
  body?: string,
  okStatuses: number[] = [],
): Promise<string> {
  const response = await request(url, method, config, headers, body);
  const text = await response.text();
  if (response.status === 401) {
    throw new Error("DAV authentication failed: check Apple Account and app-specific password");
  }
  if (!(okStatuses.includes(response.status) || response.ok)) {
    throw new Error(`DAV ${method} failed: HTTP ${response.status}: ${compact(text)}`);
  }
  return text;
}

async function request(
  url: string,
  method: string,
  config: DavAccountConfig,
  headers: Record<string, string>,
  body?: string,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
      ...headers,
    },
    body,
  });
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 400);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
