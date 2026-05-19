import fs from "node:fs";
import path from "node:path";

export interface ImageGenerationConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  quality: string;
  size: string;
  outputDir: string;
}

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
  path: string;
}

const IMAGE_INTENT_PATTERNS = [
  /(?:生成|画|绘制|做|制作|创建|出|来)(?:一张|一个|幅|张)?[^。！？\n]*(?:图|图片|插画|海报|头像|壁纸|封面|logo|标志|照片|表情包)/i,
  /(?:帮我|请)?(?:画|生成|制作|创建)[^。！？\n]+/i,
  /\b(?:generate|create|draw|make)\b[^.?!\n]*\b(?:image|picture|photo|poster|illustration|logo|avatar|wallpaper)\b/i,
];

const NEGATIVE_INTENT_PATTERNS = [
  /(?:不要|别|不用|无需).{0,8}(?:生成|画|绘制).{0,8}(?:图|图片)/i,
  /\b(?:do not|don't|no need to)\b[^.?!\n]*\b(?:generate|create|draw)\b[^.?!\n]*\b(?:image|picture|photo)\b/i,
];

export function isImageGenerationRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (NEGATIVE_INTENT_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return IMAGE_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function extractImagePrompt(text: string): string {
  return text
    .replace(/^(?:请|麻烦|帮我|给我|please)\s*/i, "")
    .replace(/^(?:生成|画|绘制|做|制作|创建|generate|create|draw|make)\s*(?:一张|一个|幅|张)?\s*/i, "")
    .trim();
}

export async function generateImage(
  prompt: string,
  config: ImageGenerationConfig,
  log: (msg: string) => void,
): Promise<GeneratedImage> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const finalPrompt = prompt.trim();
  if (!finalPrompt) {
    throw new Error("Image prompt is empty");
  }

  log(`Generating image with ${config.model}: ${preview(finalPrompt)}`);

  const res = await fetch(buildImageGenerationUrl(config.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      prompt: finalPrompt,
      size: config.size,
      quality: config.quality,
      n: 1,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Image generation failed: HTTP ${res.status}: ${text}`);
  }

  const json = JSON.parse(text) as {
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };
  const item = json.data?.[0];
  if (!item) {
    throw new Error("Image generation returned no image data");
  }

  let buffer: Buffer;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const imageRes = await fetch(item.url);
    if (!imageRes.ok) {
      throw new Error(`Generated image download failed: HTTP ${imageRes.status}`);
    }
    buffer = Buffer.from(await imageRes.arrayBuffer());
  } else {
    throw new Error("Image generation response did not include b64_json or url");
  }

  fs.mkdirSync(config.outputDir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const outputPath = path.join(config.outputDir, filename);
  fs.writeFileSync(outputPath, buffer);

  return {
    buffer,
    mimeType: "image/png",
    path: outputPath,
  };
}

function preview(text: string): string {
  return text.length > 80 ? `${text.substring(0, 80)}...` : text;
}

function buildImageGenerationUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  if (normalized.endsWith("/v1")) return `${normalized}/images/generations`;
  return `${normalized}/v1/images/generations`;
}
