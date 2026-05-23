import type { CalendarCreateDraft, CalendarMoment } from "./caldav.js";

const TRIGGER_PATTERN = /^(?:\/calendar\s+add|添加日历|加入日历|写入日历|创建日程|创建日历事件)\b/i;

export function isCalendarCreateRequest(text: string): boolean {
  return TRIGGER_PATTERN.test(text.trim());
}

export function parseCalendarCreateRequest(
  text: string,
): { ok: true; draft: CalendarCreateDraft } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: usageText() };
  }

  if (trimmed.includes("\n")) {
    return parseKeyValueRequest(trimmed);
  }

  return parsePipeRequest(trimmed);
}

export function calendarCommandUsage(): string {
  return usageText();
}

function parseKeyValueRequest(
  text: string,
): { ok: true; draft: CalendarCreateDraft } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = new Map<string, string>();

  for (const line of lines.slice(1)) {
    const match = line.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (!match) continue;
    fields.set(normalizeFieldName(match[1]), match[2].trim());
  }

  return buildDraftFromFields(fields);
}

function parsePipeRequest(
  text: string,
): { ok: true; draft: CalendarCreateDraft } | { ok: false; error: string } {
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    return { ok: false, error: usageText() };
  }

  const fields = new Map<string, string>();
  fields.set("title", stripTrigger(parts[1] ?? ""));
  fields.set("start", parts[2] ?? "");
  if (parts[3]) fields.set("end", parts[3]);
  if (parts[4]) fields.set("location", parts[4]);
  if (parts[5]) fields.set("notes", parts[5]);
  return buildDraftFromFields(fields);
}

function buildDraftFromFields(
  fields: Map<string, string>,
): { ok: true; draft: CalendarCreateDraft } | { ok: false; error: string } {
  const title = fields.get("title") ?? fields.get("summary") ?? "";
  const startRaw = fields.get("start") ?? "";
  const endRaw = fields.get("end");

  if (!title || !startRaw) {
    return { ok: false, error: usageText() };
  }

  const start = parseMoment(startRaw);
  if (!start) {
    return { ok: false, error: `无法识别开始时间：${startRaw}\n\n${usageText()}` };
  }

  const parsedEnd = endRaw ? parseMoment(endRaw) : undefined;
  if (endRaw && !parsedEnd) {
    return { ok: false, error: `无法识别结束时间：${endRaw}\n\n${usageText()}` };
  }

  const end = parsedEnd ?? undefined;

  if (end && end.kind !== start.kind) {
    return { ok: false, error: "开始时间和结束时间的格式要一致，要么都写日期，要么都写日期时间。" };
  }

  return {
    ok: true,
    draft: {
      title,
      start,
      end,
      location: fields.get("location") || undefined,
      notes: fields.get("notes") || fields.get("description") || undefined,
    },
  };
}

function parseMoment(raw: string): CalendarMoment | null {
  const normalized = raw.trim().replace(/\//g, "-");
  const dateOnly = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return {
      kind: "date",
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
    };
  }

  const dateTime = normalized.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!dateTime) return null;

  return {
    kind: "date-time",
    year: Number(dateTime[1]),
    month: Number(dateTime[2]),
    day: Number(dateTime[3]),
    hour: Number(dateTime[4]),
    minute: Number(dateTime[5]),
  };
}

function normalizeFieldName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["标题", "title", "summary", "主题"].includes(normalized)) return "title";
  if (["开始", "开始时间", "start", "starttime"].includes(normalized)) return "start";
  if (["结束", "结束时间", "end", "endtime"].includes(normalized)) return "end";
  if (["地点", "位置", "location"].includes(normalized)) return "location";
  if (["备注", "说明", "描述", "notes", "description"].includes(normalized)) return "notes";
  return normalized;
}

function stripTrigger(value: string): string {
  return value.replace(TRIGGER_PATTERN, "").trim();
}

function usageText(): string {
  return [
    "日历命令格式：",
    "1. 单行：添加日历 | 标题 | 2026-06-19 09:00 | 2026-06-19 18:00 | 地点 | 备注",
    "2. 多行：",
    "添加日历",
    "标题: 端午出行",
    "开始: 2026-06-19 09:00",
    "结束: 2026-06-19 18:00",
    "地点: 安吉",
    "备注: 检查高速是否免费",
    "时间支持 YYYY-MM-DD 或 YYYY-MM-DD HH:mm。",
  ].join("\n");
}
