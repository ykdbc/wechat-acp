export interface MapsIntegrationConfig {
  enabled: boolean;
  defaultMapType: "m" | "k" | "h" | "r";
  defaultZoom?: number;
}

export function buildAppleMapsUrl(
  query: string,
  config: MapsIntegrationConfig,
): string {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("地图查询不能为空");
  }
  const url = new URL("https://maps.apple.com/");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("address", trimmed);
  url.searchParams.set("t", config.defaultMapType);
  if (config.defaultZoom !== undefined) {
    url.searchParams.set("z", String(config.defaultZoom));
  }
  return url.toString();
}
