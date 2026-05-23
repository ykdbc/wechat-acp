import type { CalendarEventDraft, CalendarMoment } from "../calendar/service.js";
import type { ContactDraft } from "../contacts/service.js";
import type { BotAction } from "./actions.js";

export function parseBotAction(text: string): BotAction | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return parseMapLookup(trimmed)
    ?? parseContactCreate(trimmed)
    ?? parseContactDelete(trimmed)
    ?? parseContactLookup(trimmed)
    ?? parseCalendarCreate(trimmed)
    ?? parseCalendarDelete(trimmed)
    ?? parseCalendarLookup(trimmed);
}

function parseMapLookup(text: string): BotAction | null {
  const match = text.match(/^(?:查询一下|查一下|帮我查一下|搜索一下|搜一下)(.+?)(?:，|,)?(?:把地图发给我|发我地图|给我地图)?$/);
  if (!match?.[1]) return null;
  const query = cleanupEntity(match[1]);
  if (!query) return null;
  return { type: "map.lookup", query };
}

function parseContactCreate(text: string): BotAction | null {
  const match = text.match(
    /^(?:添加|新增|加入)(.+?)(?:到|进)?通讯录(?:，|,)?(?:电话|手机号|号码)?[:： ]*([+\d][\d\s-]{5,})(?:，|,)?(?:备注[:： ]*(.+))?$/i,
  );
  if (!match?.[1] || !match?.[2]) return null;
  return {
    type: "contact.create",
    draft: {
      fullName: cleanupEntity(match[1]),
      phones: [normalizePhone(match[2])],
      note: match[3]?.trim() || undefined,
    },
  };
}

function parseContactDelete(text: string): BotAction | null {
  const match = text.match(/^(?:删除|移除|删掉)(.+?)(?:从)?通讯录$/);
  if (!match?.[1]) return null;
  return {
    type: "contact.list",
    query: cleanupEntity(match[1]),
  };
}

function parseContactLookup(text: string): BotAction | null {
  const match = text.match(/^(?:查一下|查询一下|看看)(.+?)(?:的)?(?:电话|手机号|联系方式|通讯录)$/);
  if (!match?.[1]) return null;
  return {
    type: "contact.list",
    query: cleanupEntity(match[1]),
  };
}

function parseCalendarCreate(text: string): BotAction | null {
  const explicit = parseCalendarPipeOrBlock(text);
  if (explicit) return { type: "calendar.create", draft: explicit };

  const match = text.match(/^(?:给我|帮我)?(?:添加|加入|加个|创建)(.+?)(?:到|进)?日历(?:提醒)?$/);
  if (!match?.[1]) return null;

  const body = cleanupEntity(match[1]);
  const temporal = extractTemporalHint(body);
  return {
    type: "calendar.create",
    draft: {
      title: temporal.title,
      start: temporal.start,
      end: temporal.end,
    },
  };
}

function parseCalendarDelete(text: string): BotAction | null {
  const match = text.match(/^(?:删除|移除|删掉)(.+?)(?:日程|提醒|日历事件)$/);
  if (!match?.[1]) return null;
  return {
    type: "calendar.list",
    query: cleanupEntity(match[1]),
  };
}

function parseCalendarLookup(text: string): BotAction | null {
  const match = text.match(/^(?:查询|查看|看看)(.+?)(?:日程|安排|提醒)$/);
  if (!match?.[1]) return null;
  return {
    type: "calendar.list",
    query: cleanupEntity(match[1]),
  };
}

function parseCalendarPipeOrBlock(text: string): CalendarEventDraft | null {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && /^(?:添加日历|加入日历|写入日历|创建日程|创建日历事件)$/.test(lines[0] ?? "")) {
    const fields = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const match = line.match(/^([^:：]+)[:：]\s*(.+)$/);
      if (!match) continue;
      fields.set(normalizeCalendarFieldName(match[1]), match[2].trim());
    }
    return buildCalendarDraft(fields);
  }

  if (!text.includes("|")) return null;
  const parts = text.split("|").map((part) => part.trim());
  if (parts.length < 3) return null;
  if (!/^(?:添加日历|加入日历|写入日历|创建日程|创建日历事件)$/.test(parts[0] ?? "")) return null;

  const fields = new Map<string, string>();
  fields.set("title", parts[1] ?? "");
  fields.set("start", parts[2] ?? "");
  if (parts[3]) fields.set("end", parts[3]);
  if (parts[4]) fields.set("location", parts[4]);
  if (parts[5]) fields.set("notes", parts[5]);
  return buildCalendarDraft(fields);
}

function buildCalendarDraft(fields: Map<string, string>): CalendarEventDraft | null {
  const title = fields.get("title")?.trim();
  const start = fields.get("start") ? parseMoment(fields.get("start")!) : null;
  const end = fields.get("end") ? parseMoment(fields.get("end")!) : undefined;
  if (!title || !start) return null;
  if (end && end.kind !== start.kind) return null;
  return {
    title,
    start,
    end,
    location: fields.get("location")?.trim() || undefined,
    notes: fields.get("notes")?.trim() || undefined,
  };
}

function extractTemporalHint(body: string): CalendarEventDraft {
  const normalized = body.replace(/提醒我/g, "").trim();

  let title = normalized;
  let start: CalendarMoment = {
    kind: "date-time",
    year: 2099,
    month: 1,
    day: 1,
    hour: 9,
    minute: 0,
  };
  let end: CalendarMoment | undefined;

  const tomorrowMatch = normalized.match(/^明天(?:(上午|中午|下午|晚上))?(\d{1,2})点(?:(\d{1,2})分?)?(.+)$/);
  if (tomorrowMatch) {
    const period = tomorrowMatch[1] ?? "";
    const rawHour = Number(tomorrowMatch[2]);
    const minute = tomorrowMatch[3] ? Number(tomorrowMatch[3]) : 0;
    const adjustedHour = adjustHourByPeriod(rawHour, period);
    title = cleanupEntity(tomorrowMatch[4] ?? normalized);

    const base = new Date();
    base.setDate(base.getDate() + 1);
    start = {
      kind: "date-time",
      year: base.getFullYear(),
      month: base.getMonth() + 1,
      day: base.getDate(),
      hour: adjustedHour,
      minute,
    };
    end = {
      ...start,
      hour: Math.min(adjustedHour + 1, 23),
    };
  }

  return { title, start, end };
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

function normalizeCalendarFieldName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["标题", "title", "summary", "主题"].includes(normalized)) return "title";
  if (["开始", "开始时间", "start", "starttime"].includes(normalized)) return "start";
  if (["结束", "结束时间", "end", "endtime"].includes(normalized)) return "end";
  if (["地点", "位置", "location"].includes(normalized)) return "location";
  if (["备注", "说明", "描述", "notes", "description"].includes(normalized)) return "notes";
  return normalized;
}

function adjustHourByPeriod(hour: number, period: string): number {
  if (period === "下午" || period === "晚上") return hour < 12 ? hour + 12 : hour;
  return hour;
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "");
}

function cleanupEntity(value: string): string {
  return value.replace(/^(?:一下|一下子)/, "").replace(/[，。,.\s]+$/g, "").trim();
}
