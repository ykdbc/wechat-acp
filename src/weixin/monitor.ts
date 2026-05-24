/**
 * WeChat long-poll monitor loop.
 * Polls getUpdates, dispatches messages via callback.
 */

import fs from "node:fs";
import path from "node:path";
import { getUpdates } from "./api.js";
import type { WeixinMessage, GetUpdatesResp } from "./types.js";
import { trackException } from "../telemetry/index.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;

export interface MonitorOpts {
  baseUrl: string;
  token?: string;
  storageDir: string;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  log: (msg: string) => void;
  onMessage: (msg: WeixinMessage) => void;
}

function getSyncBufPath(storageDir: string): string {
  return path.join(storageDir, "sync-buf.json");
}

function loadSyncBuf(storageDir: string): string {
  const p = getSyncBufPath(storageDir);
  if (!fs.existsSync(p)) return "";
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as { get_updates_buf?: string };
    return data.get_updates_buf ?? "";
  } catch {
    return "";
  }
}

function saveSyncBuf(storageDir: string, buf: string): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(getSyncBufPath(storageDir), JSON.stringify({ get_updates_buf: buf }), "utf-8");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

export async function startMonitor(opts: MonitorOpts): Promise<void> {
  const { baseUrl, token, storageDir, abortSignal, log, onMessage } = opts;

  let getUpdatesBuf = loadSyncBuf(storageDir);
  if (getUpdatesBuf) {
    log(`Resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log("No previous sync buf, starting fresh");
  }

  let nextTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp: GetUpdatesResp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          log(`Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing 1 hour...`);
          consecutiveFailures = 0;
          await sleep(60 * 60_000, abortSignal);
          continue;
        }

        consecutiveFailures++;
        log(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveSyncBuf(storageDir, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      if (resp.msgs?.length) {
        log(`getUpdates returned ${resp.msgs.length} message(s)`);
        for (const msg of resp.msgs) {
          log(`Update summary: ${summarizeMessage(msg)}`);
        }
      }

      for (const msg of resp.msgs ?? []) {
        onMessage(msg);
      }
    } catch (err) {
      if (abortSignal?.aborted) return;

      consecutiveFailures++;
      log(`getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);
      trackException(err, "monitor");

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
}

function summarizeMessage(msg: WeixinMessage): string {
  const itemTypes = (msg.item_list ?? []).map((item) => item.type).join(",");
  return [
    `message_id=${msg.message_id ?? "<none>"}`,
    `seq=${msg.seq ?? "<none>"}`,
    `client_id=${previewId(msg.client_id)}`,
    `created=${msg.create_time_ms ?? "<none>"}`,
    `message_type=${msg.message_type}`,
    `state=${msg.message_state}`,
    `from=${msg.from_user_id ? "yes" : "no"}`,
    `context=${msg.context_token ? "yes" : "no"}`,
    `group=${msg.group_id ? "yes" : "no"}`,
    `items=[${itemTypes}]`,
    `item_msg_ids=[${itemMsgIds(msg)}]`,
    `text=${previewText(extractText(msg))}`,
  ].join(" ");
}

function extractText(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.text_item?.text) return item.text_item.text;
    if (item.voice_item?.text) return item.voice_item.text;
  }
  return "";
}

function previewText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "<none>";
  return compact.length > 80 ? `${compact.substring(0, 80)}...` : compact;
}

function itemMsgIds(msg: WeixinMessage): string {
  const ids = (msg.item_list ?? [])
    .map((item) => item.msg_id)
    .filter((id): id is string => !!id)
    .map(previewId);
  return ids.length ? ids.join(",") : "<none>";
}

function previewId(value: string | undefined): string {
  if (!value) return "<none>";
  return value.length > 18 ? `${value.substring(0, 8)}...${value.substring(value.length - 6)}` : value;
}
