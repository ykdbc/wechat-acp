export interface MapsServiceConfig {
  defaultMapType?: "m" | "k" | "h" | "r";
  defaultZoom?: number;
}

export interface MapLookupRequest {
  query: string;
  near?: { latitude: number; longitude: number };
  label?: string;
  mapType?: "m" | "k" | "h" | "r";
  zoom?: number;
}

export interface MapLookupResult {
  query: string;
  title: string;
  mapUrl: string;
  embedHint: string;
}

export function buildAppleMapsUrl(
  request: MapLookupRequest,
  config?: MapsServiceConfig,
): string {
  const query = request.query.trim();
  if (!query) throw new Error("Map query is required");

  const url = new URL("https://maps.apple.com/");
  url.searchParams.set("q", request.label?.trim() || query);
  url.searchParams.set("address", query);

  if (request.near) {
    url.searchParams.set("near", `${request.near.latitude},${request.near.longitude}`);
  }

  const mapType = request.mapType ?? config?.defaultMapType;
  if (mapType) {
    url.searchParams.set("t", mapType);
  }

  const zoom = request.zoom ?? config?.defaultZoom;
  if (zoom !== undefined) {
    url.searchParams.set("z", String(zoom));
  }

  return url.toString();
}

export function lookupMap(
  request: MapLookupRequest,
  config?: MapsServiceConfig,
): MapLookupResult {
  const query = request.query.trim();
  return {
    query,
    title: request.label?.trim() || query,
    mapUrl: buildAppleMapsUrl(request, config),
    embedHint: "Send this Apple Maps link directly, or render a screenshot on a client that can open web pages.",
  };
}
