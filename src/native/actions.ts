import type { CalendarCreateDraft, CalendarMoment } from "../calendar/caldav.js";

export type NativeActionEnvelope =
  | { type: "image.generate"; prompt: string; size?: string; quality?: string }
  | { type: "contact.create"; fullName: string; phone: string; note?: string }
  | { type: "contact.append_phone"; fullName: string; phone: string }
  | { type: "contact.remove_phone"; phone: string; fullName?: string }
  | { type: "contact.lookup"; query: string }
  | { type: "contact.find_duplicate_phones" }
  | { type: "contact.delete"; query: string }
  | { type: "map.lookup"; query: string }
  | {
      type: "calendar.create";
      title: string;
      start: string;
      end?: string;
      location?: string;
      notes?: string;
      reminderMinutesBefore?: number;
    };

const ACTION_TAG_REGEX = /<wechat_acp_action>\s*([\s\S]*?)\s*<\/wechat_acp_action>/i;

export function buildNativeActionInstruction(now: Date, timeZone: string): string {
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const nowText = dateFormatter.format(now).replace(/\//g, "-");

  return [
    "NATIVE ACTION PROTOCOL:",
    `Current local time: ${nowText} (${timeZone})`,
    "You can ask the bridge to execute native actions for image generation, contacts, calendar, and maps.",
    "Only use these actions when the user explicitly asks you to generate an image or operate contacts/calendar/maps.",
    "For factual questions, date lookups, holiday queries, news, weather, prices, explanations, or general chat, do not emit an action block.",
    "When the user wants image generation or contacts/calendar/maps operations, do NOT inspect the repo, config, or local files first.",
    "Do NOT browse the web first for image generation or contacts/calendar/maps operations when the action can be executed directly.",
    "For these domains, your first priority is to emit the action block so the bridge can execute it directly.",
    "Instead, if you have enough information, reply with ONLY one XML-wrapped JSON action block and no extra prose:",
    "<wechat_acp_action>{...}</wechat_acp_action>",
    "Allowed actions:",
    '1. {"type":"image.generate","prompt":"请生成一张类似你自己用 iPhone 随手自拍的照片，普通、略带运动模糊、构图随意","size":"3840x2160","quality":"high"}',
    '2. {"type":"contact.create","fullName":"张三","phone":"13800138000","note":"供应商"}',
    '3. {"type":"contact.append_phone","fullName":"张三","phone":"13800138000"}',
    '4. {"type":"contact.remove_phone","phone":"13800138000","fullName":"张三"}',
    '5. {"type":"contact.lookup","query":"张三"}',
    '6. {"type":"contact.find_duplicate_phones"}',
    '7. {"type":"contact.delete","query":"张三"}',
    '8. {"type":"map.lookup","query":"安吉县君悦国际小区"}',
    '9. {"type":"calendar.create","title":"端午节提醒","start":"2026-06-19","end":"2026-06-20","notes":"端午节","reminderMinutesBefore":1440}',
    "For image.generate:",
    "- Put the final image prompt into prompt directly.",
    "- Preserve the user's requested style, framing, realism, and constraints in the prompt.",
    "- If the user asks for a specific resolution such as 4K or 3840x2160, include it in size.",
    '- Use quality "high" when the user asks for ultra-detailed, print-ready, or 4K output.',
    "- If the user wants an image and has already provided enough details, emit image.generate immediately.",
    "For calendar.create:",
    "- Use absolute dates/times, not relative words like tomorrow.",
    "- Use YYYY-MM-DD for all-day events.",
    "- Use YYYY-MM-DD HH:mm for timed events.",
    "- If the user asks '提前一天提醒我', set reminderMinutesBefore to 1440.",
    "- If the user refers to something in previous conversation, resolve it from the conversation context and still output absolute values.",
    "If required information is missing or ambiguous, ask a short natural-language follow-up question instead of emitting an action.",
  ].join("\n");
}

export function extractNativeActionEnvelope(text: string): {
  action: NativeActionEnvelope;
  remainingText: string;
} | null {
  const match = text.match(ACTION_TAG_REGEX);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]) as NativeActionEnvelope;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    const remainingText = text.replace(ACTION_TAG_REGEX, "").trim();
    return { action: parsed, remainingText };
  } catch {
    return null;
  }
}

export function calendarDraftFromAction(
  action: Extract<NativeActionEnvelope, { type: "calendar.create" }>,
): CalendarCreateDraft {
  const start = parseCalendarMoment(action.start);
  if (!start) {
    throw new Error(`无法识别日历开始时间：${action.start}`);
  }
  const end = action.end ? parseCalendarMoment(action.end) : undefined;
  if (end && end.kind !== start.kind) {
    throw new Error("开始时间和结束时间格式必须一致");
  }

  return {
    title: action.title.trim(),
    start,
    end: end ?? undefined,
    location: action.location?.trim() || undefined,
    notes: action.notes?.trim() || undefined,
    reminderMinutesBefore: normalizeReminder(action.reminderMinutesBefore),
  };
}

function parseCalendarMoment(value: string): CalendarMoment | null {
  const normalized = value.trim().replace(/\//g, "-");
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

function normalizeReminder(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("提醒时间必须是正整数分钟");
  }
  return Math.round(value);
}
