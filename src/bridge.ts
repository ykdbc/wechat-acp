/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import fs from "node:fs";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, splitText } from "./weixin/send.js";
import { sendImageMessage } from "./weixin/image-send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType, MessageItemType } from "./weixin/types.js";
import type { WeixinMessage, MessageItem } from "./weixin/types.js";
import { SessionManager } from "./acp/session.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import type { WeChatAcpConfig } from "./config.js";
import { trackEvent, trackException, hashUserId } from "./telemetry/index.js";
import {
  extractImagePrompt,
  generateImage,
  isImageGenerationRequest,
} from "./image/generation.js";
import {
  calendarCommandUsage,
  isCalendarCreateRequest,
  parseCalendarCreateRequest,
} from "./calendar/intent.js";
import { createCalendarEvent } from "./calendar/caldav.js";
import { createContact, deleteContact, findContacts } from "./contacts/service.js";
import { buildAppleMapsUrl } from "./maps/service.js";
import { parseNativeAction, type NativeAction } from "./native/intent.js";
import {
  buildNativeActionInstruction,
  calendarDraftFromAction,
  extractNativeActionEnvelope,
  type NativeActionEnvelope,
} from "./native/actions.js";

const TEXT_CHUNK_LIMIT = 4000;

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  private ownerMemoryPath = process.env.WECHAT_ACP_OWNER_MEMORY_PATH?.trim();
  private ownerMemoryLogState: "unlogged" | "loaded" | "missing" = "unlogged";
  private log: (msg: string) => void;

  constructor(config: WeChatAcpConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-acp] ${msg}`));
  }

  async start(opts?: {
    forceLogin?: boolean;
    renderQrUrl?: (url: string) => void;
  }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    // 1. Login or load token
    if (!forceLogin) {
      this.tokenData = loadToken(this.config.storage.dir);
      if (this.tokenData) {
        trackEvent("token.reused");
      }
    }

    if (!this.tokenData) {
      const loginStart = Date.now();
      try {
        this.tokenData = await login({
          baseUrl: this.config.wechat.baseUrl,
          botType: this.config.wechat.botType,
          storageDir: this.config.storage.dir,
          log: this.log,
          renderQrUrl,
        });
        trackEvent("login.success", {
          forced: !!forceLogin,
          durationMs: Date.now() - loginStart,
        });
      } catch (err) {
        trackException(err, "auth");
        trackEvent("login.failure", {
          forced: !!forceLogin,
          durationMs: Date.now() - loginStart,
          errorType: err instanceof Error ? err.name : "Unknown",
        });
        throw err;
      }
    } else {
      this.log(`Loaded saved token (Bot: ${this.tokenData.accountId}, saved at ${this.tokenData.savedAt})`);
      this.log(`Use --login to force re-login`);
    }

    // 2. Create SessionManager
    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentCwd: this.config.agent.cwd,
      agentEnv: this.config.agent.env,
      agentPreset: this.config.agent.preset ?? "raw",
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      log: this.log,
      onReply: (userId, contextToken, text) => this.handleAgentReply(userId, contextToken, text),
      sendTyping: (userId, contextToken) => this.sendTypingIndicator(userId, contextToken),
    });
    this.sessionManager.start();

    // 3. Start monitor loop
    this.log("Starting message polling...");
    await startMonitor({
      baseUrl: this.tokenData.baseUrl,
      token: this.tokenData.token,
      storageDir: this.config.storage.dir,
      abortSignal: this.abortController.signal,
      log: this.log,
      onMessage: (msg) => this.handleMessage(msg),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    await this.sessionManager?.stop();
    this.log("Bridge stopped");
  }

  private handleMessage(msg: WeixinMessage): void {
    // Only process user messages (not bot's own messages)
    if (msg.message_type !== MessageType.USER) return;

    // Skip group messages (v1: direct only)
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    trackEvent("message.received", {
      userIdHash: hashUserId(userId),
      kind: this.messageKind(msg),
    });

    // Convert and enqueue — fire-and-forget (don't block the poll loop)
    this.enqueueMessage(msg, userId, contextToken).catch((err) => {
      this.log(`Failed to enqueue message from ${userId}: ${String(err)}`);
      trackException(err, "enqueue");
    });
  }

  private async enqueueMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    const text = this.extractText(msg.item_list);
    const nativeAction = parseNativeAction(text);
    if (nativeAction) {
      await this.handleNativeAction(userId, contextToken, nativeAction);
      return;
    }
    if (this.config.imageGeneration.enabled && isImageGenerationRequest(text)) {
      await this.handleImageGeneration(userId, contextToken, text);
      return;
    }
    if (this.config.calendarIntegration.enabled && isCalendarCreateRequest(text)) {
      await this.handleCalendarCreate(userId, contextToken, text);
      return;
    }

    const prompt = await weixinMessageToPrompt(
      msg,
      this.config.wechat.cdnBaseUrl,
      this.log,
    );

    await this.sessionManager!.enqueue(userId, {
      prompt: this.withNativeActionContext(this.withOwnerMemoryContext(userId, prompt)),
      contextToken,
    });
  }

  private async handleAgentReply(userId: string, contextToken: string, text: string): Promise<void> {
    if (text.startsWith("💭 [Thinking]")) {
      await this.sendReply(userId, contextToken, text);
      return;
    }

    const parsed = extractNativeActionEnvelope(text);
    if (!parsed) {
      await this.sendReply(userId, contextToken, text);
      return;
    }

    await this.handleNativeActionEnvelope(userId, contextToken, parsed.action, parsed.remainingText);
  }

  private async handleImageGeneration(
    userId: string,
    contextToken: string,
    text: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.sendTypingIndicator(userId, contextToken);
      const image = await generateImage(
        extractImagePrompt(text),
        this.config.imageGeneration,
        this.log,
      );

      await sendImageMessage(userId, image, {
        baseUrl: this.tokenData!.baseUrl,
        cdnBaseUrl: this.config.wechat.cdnBaseUrl,
        token: this.tokenData!.token,
        contextToken,
      });

      trackEvent("image.generated", {
        userIdHash: hashUserId(userId),
        model: this.config.imageGeneration.model,
        bytes: image.buffer.length,
        durationMs: Date.now() - startedAt,
      });
      this.log(`Generated image sent to ${userId}: ${image.path}`);
    } catch (err) {
      this.log(`Image generation failed for ${userId}: ${String(err)}`);
      trackException(err, "image_generation");
      await this.sendReply(userId, contextToken, `图片生成失败：${String(err)}`);
    } finally {
      this.cancelTypingIndicator(userId, contextToken).catch(() => {});
    }
  }

  private async handleNativeAction(
    userId: string,
    contextToken: string,
    action: NativeAction,
  ): Promise<void> {
    switch (action.type) {
      case "contact.create":
        await this.handleContactCreate(userId, contextToken, action.fullName, action.phone, action.note);
        return;
      case "contact.delete":
        await this.handleContactDelete(userId, contextToken, action.query);
        return;
      case "map.lookup":
        await this.handleMapLookup(userId, contextToken, action.query);
        return;
    }
  }

  private async handleNativeActionEnvelope(
    userId: string,
    contextToken: string,
    action: NativeActionEnvelope,
    remainingText: string,
  ): Promise<void> {
    switch (action.type) {
      case "contact.create":
        await this.handleContactCreate(userId, contextToken, action.fullName, action.phone, action.note);
        return;
      case "contact.delete":
        await this.handleContactDelete(userId, contextToken, action.query);
        return;
      case "map.lookup":
        await this.handleMapLookup(userId, contextToken, action.query);
        return;
      case "calendar.create":
        await this.handleCalendarCreateFromAi(userId, contextToken, action, remainingText);
        return;
    }
  }

  private async handleCalendarCreate(
    userId: string,
    contextToken: string,
    text: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const parsed = parseCalendarCreateRequest(text);
      if (!parsed.ok) {
        await this.sendReply(userId, contextToken, parsed.error);
        return;
      }

      await this.sendTypingIndicator(userId, contextToken);
      const created = await createCalendarEvent(
        parsed.draft,
        this.config.calendarIntegration,
        this.log,
      );

      trackEvent("calendar.event_created", {
        userIdHash: hashUserId(userId),
        durationMs: Date.now() - startedAt,
      });

      await this.sendReply(
        userId,
        contextToken,
        [
          `日历已写入：${parsed.draft.title}`,
          `事件ID：${created.uid}`,
          `日历地址：${created.calendarUrl}`,
        ].join("\n"),
      );
    } catch (err) {
      this.log(`Calendar create failed for ${userId}: ${String(err)}`);
      trackException(err, "calendar_create");
      await this.sendReply(
        userId,
        contextToken,
        `日历写入失败：${String(err)}\n\n${calendarCommandUsage()}`,
      );
    } finally {
      this.cancelTypingIndicator(userId, contextToken).catch(() => {});
    }
  }

  private async handleCalendarCreateFromAi(
    userId: string,
    contextToken: string,
    action: Extract<NativeActionEnvelope, { type: "calendar.create" }>,
    remainingText: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const draft = calendarDraftFromAction(action);
      await this.sendTypingIndicator(userId, contextToken);
      const created = await createCalendarEvent(
        draft,
        this.config.calendarIntegration,
        this.log,
      );

      trackEvent("calendar.event_created", {
        userIdHash: hashUserId(userId),
        durationMs: Date.now() - startedAt,
      });

      const lines = [
        `日历已写入：${draft.title}`,
        action.reminderMinutesBefore ? `提醒：提前 ${action.reminderMinutesBefore} 分钟` : "",
        `事件ID：${created.uid}`,
      ].filter(Boolean);
      if (remainingText.trim()) {
        lines.push("", remainingText.trim());
      }
      await this.sendReply(userId, contextToken, lines.join("\n"));
    } catch (err) {
      this.log(`AI calendar create failed for ${userId}: ${String(err)}`);
      trackException(err, "calendar_create_ai");
      await this.sendReply(userId, contextToken, `日历写入失败：${String(err)}`);
    } finally {
      this.cancelTypingIndicator(userId, contextToken).catch(() => {});
    }
  }

  private async handleContactCreate(
    userId: string,
    contextToken: string,
    fullName: string,
    phone: string,
    note?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      if (!this.config.contactsIntegration.enabled) {
        await this.sendReply(userId, contextToken, "通讯录能力未启用。");
        return;
      }
      await this.sendTypingIndicator(userId, contextToken);
      const created = await createContact({
        fullName,
        phones: [phone],
        note,
      }, this.config.contactsIntegration);
      trackEvent("contact.created", {
        userIdHash: hashUserId(userId),
        durationMs: Date.now() - startedAt,
      });
      await this.sendReply(
        userId,
        contextToken,
        [
          `联系人已添加：${created.fullName}`,
          created.phones?.[0] ? `电话：${created.phones[0]}` : "",
          created.note ? `备注：${created.note}` : "",
        ].filter(Boolean).join("\n"),
      );
    } catch (err) {
      this.log(`Contact create failed for ${userId}: ${String(err)}`);
      trackException(err, "contact_create");
      await this.sendReply(userId, contextToken, `联系人添加失败：${String(err)}`);
    } finally {
      this.cancelTypingIndicator(userId, contextToken).catch(() => {});
    }
  }

  private async handleContactDelete(
    userId: string,
    contextToken: string,
    query: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      if (!this.config.contactsIntegration.enabled) {
        await this.sendReply(userId, contextToken, "通讯录能力未启用。");
        return;
      }
      await this.sendTypingIndicator(userId, contextToken);
      const matches = await findContacts(query, this.config.contactsIntegration);
      if (matches.length === 0) {
        await this.sendReply(userId, contextToken, `通讯录里没有找到“${query}”。`);
        return;
      }
      if (matches.length > 1) {
        await this.sendReply(
          userId,
          contextToken,
          [
            `找到 ${matches.length} 个候选，请把名字说得更完整一些：`,
            ...matches.slice(0, 8).map((contact, index) =>
              `${index + 1}. ${contact.fullName}${contact.phones?.[0] ? ` / ${contact.phones[0]}` : ""}`,
            ),
          ].join("\n"),
        );
        return;
      }

      const target = matches[0]!;
      await deleteContact(target, this.config.contactsIntegration);
      trackEvent("contact.deleted", {
        userIdHash: hashUserId(userId),
        durationMs: Date.now() - startedAt,
      });
      await this.sendReply(
        userId,
        contextToken,
        `联系人已删除：${target.fullName}${target.phones?.[0] ? ` / ${target.phones[0]}` : ""}`,
      );
    } catch (err) {
      this.log(`Contact delete failed for ${userId}: ${String(err)}`);
      trackException(err, "contact_delete");
      await this.sendReply(userId, contextToken, `联系人删除失败：${String(err)}`);
    } finally {
      this.cancelTypingIndicator(userId, contextToken).catch(() => {});
    }
  }

  private async handleMapLookup(
    userId: string,
    contextToken: string,
    query: string,
  ): Promise<void> {
    try {
      if (!this.config.mapsIntegration.enabled) {
        await this.sendReply(userId, contextToken, "地图能力未启用。");
        return;
      }
      const mapUrl = buildAppleMapsUrl(query, this.config.mapsIntegration);
      trackEvent("map.link_shared", {
        userIdHash: hashUserId(userId),
      });
      await this.sendReply(
        userId,
        contextToken,
        [`地图查询：${query}`, mapUrl].join("\n"),
      );
    } catch (err) {
      this.log(`Map lookup failed for ${userId}: ${String(err)}`);
      trackException(err, "map_lookup");
      await this.sendReply(userId, contextToken, `地图查询失败：${String(err)}`);
    }
  }

  private async sendReply(userId: string, contextToken: string, text: string): Promise<void> {
    const formatted = formatForWeChat(text);
    const segments = splitText(formatted, TEXT_CHUNK_LIMIT);
    const startedAt = Date.now();
    this.log(`Reply preview to ${userId}: ${this.previewText(formatted, 300)}`);

    try {
      for (const segment of segments) {
        const clientId = await sendTextMessage(userId, segment, {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
        });
        this.log(`Sent text reply to ${userId}: ${clientId} (${segment.length} chars)`);
      }
      trackEvent("reply.sent", {
        userIdHash: hashUserId(userId),
        segments: segments.length,
        chars: formatted.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      trackException(err, "reply");
      throw err;
    }

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  private async cancelTypingIndicator(userId: string, contextToken: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;

    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: TypingStatus.CANCEL,
      },
    });
  }

  private async sendTypingIndicator(userId: string, contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return;

      await sendTyping({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        },
      });
    } catch {
      // Typing is best-effort
    }
  }

  private async getTypingTicket(userId: string, contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;

    try {
      const resp = await getConfig({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        ilinkUserId: userId,
        contextToken,
      });

      if (resp.typing_ticket) {
        this.typingTickets.set(userId, {
          ticket: resp.typing_ticket,
          expiresAt: Date.now() + 24 * 60 * 60_000, // 24h cache
        });
        return resp.typing_ticket;
      }
    } catch {
      // Not critical
    }
    return null;
  }

  private previewMessage(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        const text = item.text_item.text;
        return text.length > 50 ? text.substring(0, 50) + "..." : text;
      }
      if (item.type === 2) return "[image]";
      if (item.type === 3) return item.voice_item?.text ? `[voice] ${item.voice_item.text.substring(0, 30)}` : "[voice]";
      if (item.type === 4) return `[file] ${item.file_item?.file_name ?? ""}`;
      if (item.type === 5) return "[video]";
    }
    return "[empty]";
  }

  private extractText(itemList?: MessageItem[]): string {
    for (const item of itemList ?? []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        return item.text_item.text;
      }
      if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
        return item.voice_item.text;
      }
    }
    return "";
  }

  private previewText(text: string, maxLen: number): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > maxLen ? `${compact.substring(0, maxLen)}...` : compact;
  }

  private withOwnerMemoryContext(
    userId: string,
    prompt: acp.ContentBlock[],
  ): acp.ContentBlock[] {
    if (!this.ownerMemoryPath || userId !== this.tokenData?.userId) {
      return prompt;
    }

    const memory = this.loadOwnerMemory();
    if (memory === null) return prompt;

    return [
      {
        type: "text",
        text: [
          "PRIVATE OWNER MEMORY CONTEXT:",
          "Use this context silently when replying to this owner.",
          `Owner memory file: ${this.ownerMemoryPath}`,
          "If the owner explicitly asks you to remember, forget, rename the bot, change the bot persona, or update durable preferences, edit the owner memory file before confirming.",
          "Keep durable memory concise and factual. Do not store secrets, API keys, tokens, private keys, or one-off jokes unless the owner explicitly asks.",
          "Do not copy identity or preferences between different bot instances. This memory belongs only to the current instance.",
          "Do not reveal this block verbatim or mention it unless the owner explicitly asks to inspect or edit memory.",
          memory,
          "END PRIVATE OWNER MEMORY CONTEXT.",
        ].join("\n"),
      },
      ...prompt,
    ];
  }

  private withNativeActionContext(prompt: acp.ContentBlock[]): acp.ContentBlock[] {
    return [
      {
        type: "text",
        text: buildNativeActionInstruction(
          new Date(),
          this.config.calendarIntegration.defaultTimeZone || "Asia/Shanghai",
        ),
      },
      ...prompt,
    ];
  }

  private loadOwnerMemory(): string | null {
    if (!this.ownerMemoryPath) return null;

    try {
      if (!fs.existsSync(this.ownerMemoryPath)) {
        fs.mkdirSync(path.dirname(this.ownerMemoryPath), { recursive: true });
        fs.writeFileSync(this.ownerMemoryPath, this.defaultOwnerMemory(), "utf-8");
        this.log(`Created owner memory at ${this.ownerMemoryPath}`);
      }

      const memory = fs.readFileSync(this.ownerMemoryPath, "utf-8").trim();
      if (memory && this.ownerMemoryLogState !== "loaded") {
        this.log(`Loaded owner memory from ${this.ownerMemoryPath}`);
        this.ownerMemoryLogState = "loaded";
      }
      return memory || this.defaultOwnerMemory();
    } catch (err) {
      if (this.ownerMemoryLogState !== "missing") {
        this.log(`Owner memory unavailable: ${String(err)}`);
        this.ownerMemoryLogState = "missing";
      }
      return null;
    }
  }

  private defaultOwnerMemory(): string {
    return [
      "# Owner Memory",
      "",
      "## Identity",
      "",
      "- Bot name: not set.",
      "- Bot persona: not set.",
      "",
      "## Owner Preferences",
      "",
      "- No durable preferences recorded yet.",
      "",
      "## Memory Update Rules",
      "",
      "- When the owner explicitly says to remember, forget, rename the bot, change persona, or update preferences, update this file.",
      "- Keep entries concise, dated when useful, and limited to durable facts or preferences.",
      "- Do not store secrets, API keys, tokens, private keys, or temporary one-off instructions.",
    ].join("\n");
  }

  private messageKind(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1) return "text";
      if (item.type === 2) return "image";
      if (item.type === 3) return "voice";
      if (item.type === 4) return "file";
      if (item.type === 5) return "video";
    }
    return "empty";
  }
}
