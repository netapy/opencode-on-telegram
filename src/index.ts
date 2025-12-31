import { Bot, InlineKeyboard, type Api } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import {
  createOpencode,
  type Event,
  type TextPart,
  type ToolPart,
  type ReasoningPart,
  type StepFinishPart,
  type Permission,
  type OpencodeClient,
  type Session,
} from "@opencode-ai/sdk";

// Config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS?.split(",").map(Number) ?? [];
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT) || 4097;

// Throttle config
const UPDATE_INTERVAL_MS = 800;
const MIN_CHARS_DELTA = 30;

// Per-user sessions
const userSessions = new Map<number, string>();

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN required");
  process.exit(1);
}

// Display state during streaming
interface DisplayState {
  phase: "thinking" | "reasoning" | "tools" | "responding" | "permission";
  userInput: string;
  reasoning: string;
  tools: Map<string, { name: string; title: string; status: string }>;
  text: string;
  filesEdited: string[];
  tokens: { input: number; output: number };
  cost: number;
  pendingPermission: Permission | null;
  aborted: boolean;
}

function createDisplayState(userInput: string): DisplayState {
  return {
    phase: "thinking",
    userInput,
    reasoning: "",
    tools: new Map(),
    text: "",
    filesEdited: [],
    tokens: { input: 0, output: 0 },
    cost: 0,
    pendingPermission: null,
    aborted: false,
  };
}

type ActiveMessage = {
  userId: number;
  sessionId: string;
  state: DisplayState;
  resolvePermission?: () => void;
  abortController: AbortController;
};

type MenuState = {
  userId: number;
  page: number;
  sessionIds: string[];
};

const activeMessages = new Map<string, ActiveMessage>();
const menuStates = new Map<string, MenuState>();
const sessionTitleCache = new Map<string, string>();

const EMPTY_INLINE_KEYBOARD = new InlineKeyboard();
const MENU_PAGE_SIZE = 6;

const TOOL_ICONS: Record<string, string> = {
  read: "📖",
  edit: "✏️",
  write: "📝",
  bash: "⚡",
  glob: "🔍",
  grep: "🔎",
  webfetch: "🌐",
  task: "🤖",
  todowrite: "📋",
  todoread: "📋",
};

const PERMISSION_ICONS: Record<string, string> = {
  edit: "✏️",
  write: "📝",
  bash: "⚡",
  delete: "🗑️",
};

function messageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function getActiveMessageFromCallback(ctx: {
  callbackQuery?: { message?: { message_id: number; chat: { id: number } } };
}): ActiveMessage | null {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return null;
  const key = messageKey(msg.chat.id, msg.message_id);
  return activeMessages.get(key) ?? null;
}

function parseMessageKey(key: string): { chatId: number; messageId: number } | null {
  const [chatIdRaw, messageIdRaw] = key.split(":");
  if (!chatIdRaw || !messageIdRaw) return null;
  const chatId = Number(chatIdRaw);
  const messageId = Number(messageIdRaw);
  if (Number.isNaN(chatId) || Number.isNaN(messageId)) return null;
  return { chatId, messageId };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

// Non-destructive tools that don't need permission
const AUTO_ALLOW_TYPES = new Set(["read", "glob", "grep", "todoread", "webfetch"]);

function shouldAutoAllow(permission: Permission): boolean {
  return AUTO_ALLOW_TYPES.has(permission.type);
}

function formatPermissionRequest(permission: Permission): string {
  const icon = PERMISSION_ICONS[permission.type] ?? "🔐";
  return `${icon} ${permission.title}`;
}

function formatToolStatus(tool: { name: string; title: string; status: string }): string {
  const statusIcon = tool.status === "completed" ? "✓" : tool.status === "error" ? "✗" : "…";
  const toolIcon = TOOL_ICONS[tool.name] ?? "🔧";
  return `${toolIcon} ${tool.title || tool.name} ${statusIcon}`;
}

function renderDisplay(state: DisplayState): string {
  if (state.aborted) return "⏹ Stopped.";

  if (state.phase === "permission" && state.pendingPermission) {
    return formatPermissionRequest(state.pendingPermission);
  }

  if (state.text) return state.text;

  if (state.phase === "thinking") return "💭 Thinking...";

  if (state.phase === "reasoning" && state.reasoning) {
    return `🧠 ${truncate(state.reasoning, 200)}`;
  }

  if (state.phase === "tools") {
    const lines = [...state.tools.values()].map(formatToolStatus);
    return lines.length > 0 ? lines.join("\n") : "⚙️ Working...";
  }

  return "💭 Thinking...";
}

// Inline keyboard for abort + menu
function abortKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⏹ Stop", "abort")
    .text("☰ Menu", "menu");
}

function idleKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("☰ Menu", "menu");
}

// Inline keyboard for permission request
function permissionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Allow", "perm:once")
    .text("Always", "perm:always")
    .text("Skip", "perm:reject")
    .row()
    .text("⏹ Stop", "abort")
    .text("☰ Menu", "menu");
}

function renderFinalMessage(state: DisplayState): string {
  const sections: string[] = [];

  // Tools chain (compact, one line above response)
  if (state.tools.size > 0) {
    const toolChain = [...state.tools.values()]
      .map(t => `${TOOL_ICONS[t.name] || "🔧"} ${t.title}`)
      .join(" → ");
    sections.push(toolChain, "");
  }

  if (state.text) {
    sections.push(state.text);
  }

  const footerParts: string[] = [];

  if (state.filesEdited.length > 0) {
    const files = state.filesEdited.map(f => f.split("/").pop()).join(", ");
    footerParts.push(`✏️ ${files}`);
  }

  if (state.tokens.input + state.tokens.output > 0) {
    const total = ((state.tokens.input + state.tokens.output) / 1000).toFixed(1);
    footerParts.push(`${total}k tok`);
  }
  if (state.cost > 0) {
    footerParts.push(`$${state.cost.toFixed(3)}`);
  }

  if (footerParts.length > 0) {
    sections.push(`\n—\n${footerParts.join(" · ")}`);
  }

  return sections.join("\n") || "Done.";
}

function updateSessionCache(sessions: Session[]): void {
  for (const session of sessions) {
    sessionTitleCache.set(session.id, session.title);
  }
}

async function getCurrentSessionTitle(opencode: OpencodeClient, sessionId?: string): Promise<string | null> {
  if (!sessionId) return null;
  const cached = sessionTitleCache.get(sessionId);
  if (cached) return cached;
  try {
    const { data } = await opencode.session.get({ path: { id: sessionId } });
    if (data?.title) {
      sessionTitleCache.set(sessionId, data.title);
      return data.title;
    }
  } catch {
    // ignore
  }
  return sessionId.slice(0, 8);
}

async function listSessions(opencode: OpencodeClient): Promise<Session[]> {
  const { data } = await opencode.session.list();
  const sessions = data ?? [];
  sessions.sort((a, b) => b.time.updated - a.time.updated);
  updateSessionCache(sessions);
  return sessions;
}

function formatCurrentLabel(currentTitle: string | null): string {
  return currentTitle ? `Current: ${currentTitle}` : "Current: None";
}

function menuMainText(currentTitle: string | null): string {
  return `Menu\n${formatCurrentLabel(currentTitle)}`;
}

function menuMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🗂 Conversations", "menu:sessions")
    .row()
    .text("✨ New conversation", "menu:new")
    .row()
    .text("🧹 Clear current", "menu:clear")
    .row()
    .text("✖ Close", "menu:close");
}

function menuClearText(currentTitle: string | null): string {
  return `Clear current conversation?\n${formatCurrentLabel(currentTitle)}`;
}

function menuClearKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Clear", "menu:clear:confirm")
    .row()
    .text("⬅ Back", "menu:back")
    .text("✖ Close", "menu:close");
}

function buildSessionsMenu(params: {
  sessions: Session[];
  page: number;
  currentSessionId?: string;
  currentTitle: string | null;
}): {
  text: string;
  keyboard: InlineKeyboard;
  sessionIds: string[];
  page: number;
} {
  const { sessions, currentSessionId, currentTitle } = params;
  const total = sessions.length;
  const pageCount = Math.max(1, Math.ceil(total / MENU_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(params.page, 0), pageCount - 1);
  const start = pageIndex * MENU_PAGE_SIZE;
  const pageSessions = sessions.slice(start, start + MENU_PAGE_SIZE);
  const sessionIds = pageSessions.map(session => session.id);

  const text = `Conversations (${pageIndex + 1}/${pageCount})\n${formatCurrentLabel(currentTitle)}`;
  const keyboard = new InlineKeyboard();

  if (pageSessions.length === 0) {
    keyboard.text("(empty)", "menu:noop").row();
  } else {
    pageSessions.forEach((session, index) => {
      const isCurrent = session.id === currentSessionId;
      const prefix = isCurrent ? "• " : "";
      const label = truncate(`${prefix}${session.title}`, 28);
      keyboard.text(label, `menu:switch:${index}`).row();
    });
  }

  if (pageCount > 1) {
    if (pageIndex > 0) keyboard.text("◀ Prev", "menu:prev");
    if (pageIndex < pageCount - 1) keyboard.text("Next ▶", "menu:next");
    keyboard.row();
  }

  keyboard.text("⬅ Back", "menu:back").text("✖ Close", "menu:close");

  return { text, keyboard, sessionIds, page: pageIndex };
}

function getMenuMessageFromCallback(ctx: {
  callbackQuery?: { message?: { message_id: number; chat: { id: number } } };
}): { key: string; chatId: number; messageId: number } | null {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return null;
  const key = messageKey(msg.chat.id, msg.message_id);
  return { key, chatId: msg.chat.id, messageId: msg.message_id };
}

async function updateMenuMessage(params: {
  api: Api;
  chatId: number;
  messageId: number;
  text: string;
  keyboard: InlineKeyboard;
  state: MenuState;
}): Promise<void> {
  const { api, chatId, messageId, text, keyboard, state } = params;
  const key = messageKey(chatId, messageId);
  menuStates.set(key, state);
  try {
    await api.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
  } catch (err) {
    const message = String(err);
    if (message.includes("message is not modified")) {
      return;
    }
    console.error("Menu update failed:", message);
  }
}

async function sendMenuMessage(params: {
  api: Api;
  chatId: number;
  text: string;
  keyboard: InlineKeyboard;
  state: MenuState;
  replyToMessageId?: number;
}): Promise<void> {
  const { api, chatId, text, keyboard, state, replyToMessageId } = params;
  const reply_parameters = replyToMessageId
    ? { message_id: replyToMessageId, allow_sending_without_reply: true }
    : undefined;
  const msg = await api.sendMessage(chatId, text, { reply_markup: keyboard, reply_parameters });
  const key = messageKey(chatId, msg.message_id);
  menuStates.set(key, state);
}

async function closeMenuMessage(api: Api, chatId: number, messageId: number): Promise<void> {
  await api.deleteMessage(chatId, messageId).catch(async () => {
    await api.editMessageText(chatId, messageId, "Menu closed.", { reply_markup: EMPTY_INLINE_KEYBOARD }).catch(() => {});
  });
}

async function closeMenusForUser(params: {
  api: Api;
  userId: number;
}): Promise<void> {
  const { api, userId } = params;
  const entries = [...menuStates.entries()].filter(([, state]) => state.userId === userId);
  await Promise.all(entries.map(async ([key]) => {
    menuStates.delete(key);
    const parsed = parseMessageKey(key);
    if (!parsed) return;
    const { chatId, messageId } = parsed;
    await closeMenuMessage(api, chatId, messageId);
  }));
}

async function openMenu(params: {
  api: Api;
  opencode: OpencodeClient;
  chatId: number;
  userId: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { api, opencode, chatId, userId, replyToMessageId } = params;
  const currentSessionId = userSessions.get(userId);
  const currentTitle = await getCurrentSessionTitle(opencode, currentSessionId);
  const text = menuMainText(currentTitle);
  const keyboard = menuMainKeyboard();

  await sendMenuMessage({
    api,
    chatId,
    text,
    keyboard,
    state: { userId, page: 0, sessionIds: [] },
    replyToMessageId,
  });
}

async function abortActiveStreamsForUser(params: {
  userId: number;
  opencode: OpencodeClient;
  api: Api;
}): Promise<void> {
  const { userId, opencode, api } = params;
  const entries = [...activeMessages.entries()].filter(([, entry]) => entry.userId === userId);
  await Promise.all(entries.map(async ([key, entry]) => {
    entry.state.aborted = true;
    entry.resolvePermission?.();
    entry.resolvePermission = undefined;
    entry.abortController.abort();
    void opencode.session.abort({ path: { id: entry.sessionId } }).catch(() => {});
    const parsed = parseMessageKey(key);
    if (parsed) {
      await api.editMessageText(parsed.chatId, parsed.messageId, "⏹ Stopped.", { reply_markup: idleKeyboard() }).catch(() => {});
    }
    activeMessages.delete(key);
  }));
}

async function createNewSessionForUser(params: {
  opencode: OpencodeClient;
  userId: number;
  username?: string;
}): Promise<Session | null> {
  const { opencode, userId, username } = params;
  const title = `@${username ?? userId}`;
  const { data } = await opencode.session.create({
    body: { title },
  });
  if (!data?.id) return null;
  userSessions.set(userId, data.id);
  sessionTitleCache.set(data.id, data.title);
  return data;
}

function splitMessage(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) { chunks.push(rest); break; }
    let i = rest.lastIndexOf("\n", max);
    if (i < max / 2) i = rest.lastIndexOf(" ", max);
    if (i < max / 2) i = max;
    chunks.push(rest.slice(0, i));
    rest = rest.slice(i).trimStart();
  }
  return chunks;
}

type StreamSessionParams = {
  opencode: OpencodeClient;
  api: Api;
  sessionId: string;
  chatId: number;
  messageId: number;
  userId: number;
  userText: string;
};

async function streamSession(params: StreamSessionParams): Promise<void> {
  const { opencode, api, sessionId, chatId, messageId, userText, userId } = params;
  const state = createDisplayState(userText);
  let lastRender = "";
  let lastUpdate = 0;
  let lastKeyboardToken: "abort" | "permission" = "abort";
  const key = messageKey(chatId, messageId);
  const abortController = new AbortController();

  activeMessages.set(key, { userId, sessionId, state, abortController });

  let typing = true;
  (async () => {
    while (typing) {
      await api.sendChatAction(chatId, "typing").catch(() => {});
      await new Promise(r => setTimeout(r, 4000));
    }
  })();

  const update = async (force = false) => {
    if (state.aborted) return;

    const now = Date.now();
    const rendered = renderDisplay(state);
    const permissionActive = state.phase === "permission" && Boolean(state.pendingPermission);
    const desiredToken = permissionActive ? "permission" : "abort";
    const desiredKeyboard = permissionActive ? permissionKeyboard() : abortKeyboard();
    const keyboardChanged = desiredToken !== lastKeyboardToken;

    if (!force) {
      if (rendered === lastRender && !keyboardChanged) return;
      if (now - lastUpdate < UPDATE_INTERVAL_MS && rendered === lastRender && !keyboardChanged) return;
      if (state.text && state.text.length - (lastRender.length || 0) < MIN_CHARS_DELTA && !keyboardChanged) return;
    }

    try {
      await api.editMessageText(chatId, messageId, rendered || "...", { reply_markup: desiredKeyboard });
      lastRender = rendered;
      lastUpdate = now;
      lastKeyboardToken = desiredToken;
    } catch (err) {
      const message = String(err);
      if (!message.includes("message is not modified")) {
        console.error("Edit message failed:", message);
      }
    }
  };

  try {
    const events = await opencode.event.subscribe({ signal: abortController.signal });
    await opencode.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: userText }] }
    });

    try {
      eventLoop: for await (const event of events.stream as AsyncIterable<Event>) {
        if (state.aborted) break eventLoop;
        if (!("properties" in event)) continue;
        const props = event.properties as Record<string, unknown>;

        // Filter by session
        const evtSession = (props.sessionID as string) ??
          ((props.part as Record<string, unknown>)?.sessionID as string) ??
          ((props.info as Record<string, unknown>)?.sessionID as string);
        if (evtSession && evtSession !== sessionId) continue;

        // Handle events
        switch (event.type) {
          case "permission.updated": {
            const permission = props as Permission;
            if (permission.sessionID !== sessionId) break;

            // Auto-allow non-destructive actions
            if (shouldAutoAllow(permission)) {
              await opencode.postSessionIdPermissionsPermissionId({
                path: { id: sessionId, permissionID: permission.id },
                body: { response: "once" },
              });
              break;
            }

            // Show permission request with buttons
            state.phase = "permission";
            state.pendingPermission = permission;
            await update(true);

            // Wait for user response via callback
            await new Promise<void>((resolve) => {
              const entry = activeMessages.get(key);
              if (!entry) return resolve();
              entry.resolvePermission = resolve;
            });
            if (state.aborted) break eventLoop;
            break;
          }

          case "message.part.updated": {
            const part = props.part as { type: string; sessionID?: string; messageID?: string };
            if (part.sessionID !== sessionId) break;

            if (part.type === "reasoning") {
              const r = part as ReasoningPart;
              state.phase = "reasoning";
              state.reasoning = r.text;
              await update();
            }
            else if (part.type === "tool") {
              const t = part as ToolPart;
              state.phase = "tools";
              state.tools.set(t.callID, {
                name: t.tool,
                title: t.state.status === "running" || t.state.status === "completed"
                  ? (t.state as { title?: string }).title || t.tool
                  : t.tool,
                status: t.state.status,
              });
              await update();
            }
            else if (part.type === "text") {
              const t = part as TextPart;
              // Skip if this is the user's input echoed back
              if (t.text && t.text !== state.userInput) {
                state.phase = "responding";
                state.text = t.text;
                await update();
              }
            }
            else if (part.type === "step-finish") {
              const s = part as StepFinishPart;
              state.tokens.input += s.tokens.input;
              state.tokens.output += s.tokens.output;
              state.cost += s.cost;
            }
            break;
          }

          case "file.edited": {
            const file = props.file as string;
            if (file && !state.filesEdited.includes(file)) {
              state.filesEdited.push(file);
            }
            break;
          }

          case "session.idle": {
            break;
          }
        }

        if (event.type === "session.idle") break eventLoop;
      }
    } catch (err) {
      if (!state.aborted && !abortController.signal.aborted) {
        console.error("Event stream error:", err);
      }
    } finally {
      abortController.abort();
    }

    // Final render (remove buttons)
    const final = state.aborted ? "⏹ Stopped." : renderFinalMessage(state);
    if (final.length > 4096) {
      await api.deleteMessage(chatId, messageId).catch(() => {});
      for (const chunk of splitMessage(final)) {
        await api.sendMessage(chatId, chunk);
      }
    } else {
      await api.editMessageText(chatId, messageId, final, { reply_markup: idleKeyboard() }).catch(() => {});
    }
  } catch (err) {
    console.error("Stream error:", err);
    await api.editMessageText(chatId, messageId, "Error processing message.", { reply_markup: idleKeyboard() }).catch(() => {});
  } finally {
    typing = false;
    activeMessages.delete(key);
  }
}

async function main() {
  console.log(`Starting OpenCode on port ${OPENCODE_PORT}...`);
  const { client: opencode, server } = await createOpencode({
    port: OPENCODE_PORT,
    hostname: "127.0.0.1",
  });
  console.log(`OpenCode ready at ${server.url}`);

  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  // Auth
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    if (ALLOWED_USER_IDS.length && !ALLOWED_USER_IDS.includes(uid)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Not authorized" });
      } else {
        await ctx.reply("Not authorized.");
      }
      return;
    }
    await next();
  });

  // Callback: Abort button
  bot.callbackQuery("abort", async (ctx) => {
    const entry = getActiveMessageFromCallback(ctx);
    await ctx.answerCallbackQuery({ text: "Stopped" });

    if (!entry) {
      await ctx.editMessageReplyMarkup({ reply_markup: idleKeyboard() }).catch(() => {});
      return;
    }

    entry.state.aborted = true;
    entry.resolvePermission?.();
    entry.resolvePermission = undefined;
    entry.abortController.abort();
    void opencode.session.abort({ path: { id: entry.sessionId } }).catch(() => {});

    await ctx.editMessageText("⏹ Stopped.", { reply_markup: idleKeyboard() }).catch(() => {});
  });

  // Callback: Menu button
  bot.callbackQuery("menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    const msg = ctx.callbackQuery?.message;
    if (!userId || !msg) return;
    await closeMenusForUser({ api: ctx.api, userId });
    await openMenu({
      api: ctx.api,
      opencode,
      chatId: msg.chat.id,
      userId,
      replyToMessageId: msg.message_id,
    });
  });

  // Callback: Menu actions
  bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    const userId = ctx.from?.id;
    if (!userId) return;
    const menuMsg = getMenuMessageFromCallback(ctx);
    if (!menuMsg) {
      await ctx.answerCallbackQuery();
      return;
    }

    const { chatId, messageId, key } = menuMsg;

    if (action === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    if (action === "close") {
      await ctx.answerCallbackQuery({ text: "Closed" });
      menuStates.delete(key);
      await closeMenuMessage(ctx.api, chatId, messageId);
      return;
    }

    if (action === "back") {
      await ctx.answerCallbackQuery();
      const currentTitle = await getCurrentSessionTitle(opencode, userSessions.get(userId));
      await updateMenuMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menuMainText(currentTitle),
        keyboard: menuMainKeyboard(),
        state: { userId, page: 0, sessionIds: [] },
      });
      return;
    }

    if (action === "sessions" || action === "next" || action === "prev") {
      await ctx.answerCallbackQuery();
      const currentState = menuStates.get(key);
      const currentPage = currentState?.page ?? 0;
      const nextPage = action === "next" ? currentPage + 1 : action === "prev" ? currentPage - 1 : 0;
      const sessions = await listSessions(opencode);
      const currentTitle = await getCurrentSessionTitle(opencode, userSessions.get(userId));
      const menu = buildSessionsMenu({
        sessions,
        page: nextPage,
        currentSessionId: userSessions.get(userId),
        currentTitle,
      });
      await updateMenuMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menu.text,
        keyboard: menu.keyboard,
        state: { userId, page: menu.page, sessionIds: menu.sessionIds },
      });
      return;
    }

    if (action.startsWith("switch:")) {
      await ctx.answerCallbackQuery({ text: "Switching..." });
      const index = Number(action.split(":")[1]);
      const state = menuStates.get(key);
      if (!state || !Number.isInteger(index)) return;
      const sessionId = state.sessionIds[index];
      if (!sessionId) return;

      if (userSessions.get(userId) !== sessionId) {
        await abortActiveStreamsForUser({ userId, opencode, api: ctx.api });
        userSessions.set(userId, sessionId);
      }

      const title = await getCurrentSessionTitle(opencode, sessionId);
      await ctx.api.sendMessage(chatId, `🧭 Switched to ${title ?? sessionId.slice(0, 8)}`);

      const sessions = await listSessions(opencode);
      const currentTitle = await getCurrentSessionTitle(opencode, sessionId);
      const menu = buildSessionsMenu({
        sessions,
        page: state.page,
        currentSessionId: sessionId,
        currentTitle,
      });
      await updateMenuMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menu.text,
        keyboard: menu.keyboard,
        state: { userId, page: menu.page, sessionIds: menu.sessionIds },
      });
      return;
    }

    if (action === "new") {
      await ctx.answerCallbackQuery({ text: "Starting new..." });
      await abortActiveStreamsForUser({ userId, opencode, api: ctx.api });
      const session = await createNewSessionForUser({ opencode, userId, username: ctx.from?.username });
      if (!session) {
        await ctx.api.sendMessage(chatId, "Failed to start a new conversation.");
        return;
      }
      await ctx.api.sendMessage(chatId, "✨ New conversation started.");
      const currentTitle = await getCurrentSessionTitle(opencode, session.id);
      await updateMenuMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menuMainText(currentTitle),
        keyboard: menuMainKeyboard(),
        state: { userId, page: 0, sessionIds: [] },
      });
      return;
    }

    if (action === "clear") {
      await ctx.answerCallbackQuery();
      const currentTitle = await getCurrentSessionTitle(opencode, userSessions.get(userId));
      await updateMenuMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menuMainText(currentTitle),
        keyboard: menuMainKeyboard(),
        state: { userId, page: 0, sessionIds: [] },
      });

      return;
    }

    if (action === "clear:confirm") {
      await ctx.answerCallbackQuery({ text: "Clearing..." });
      await abortActiveStreamsForUser({ userId, opencode, api: ctx.api });
      const currentId = userSessions.get(userId);
      if (currentId) {
        await opencode.session.delete({ path: { id: currentId } }).catch(() => {});
        sessionTitleCache.delete(currentId);
      }
      const session = await createNewSessionForUser({ opencode, userId, username: ctx.from?.username });
      if (!session) {
        await ctx.api.sendMessage(chatId, "Failed to clear conversation.");
        return;
      }
      await ctx.api.sendMessage(chatId, "🧹 Cleared. New conversation started.");
      const currentTitle = await getCurrentSessionTitle(opencode, session.id);
      await updateMenuMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menuMainText(currentTitle),
        keyboard: menuMainKeyboard(),
        state: { userId, page: 0, sessionIds: [] },
      });
      return;
    }

  });

  // Callback: Permission response
  bot.callbackQuery(/^perm:(once|always|reject)$/, async (ctx) => {
    const entry = getActiveMessageFromCallback(ctx);
    const response = ctx.match![1] as "once" | "always" | "reject";
    const feedback = response === "reject" ? "Skipped" : response === "always" ? "Allowed (always)" : "Allowed";

    await ctx.answerCallbackQuery({ text: feedback });

    if (!entry) return;
    const permission = entry.state.pendingPermission;
    if (!permission) return;

    await opencode.postSessionIdPermissionsPermissionId({
      path: { id: entry.sessionId, permissionID: permission.id },
      body: { response },
    });

    entry.state.pendingPermission = null;
    entry.state.phase = "tools";
    entry.resolvePermission?.();
    entry.resolvePermission = undefined;

    await ctx.editMessageReplyMarkup({ reply_markup: abortKeyboard() }).catch(() => {});
  });

  // Fallback: answer any other callbacks
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    if (data === "abort" || data === "menu" || data.startsWith("perm:") || data.startsWith("menu:")) return;
    await ctx.answerCallbackQuery();
  });

  // /start - Simple welcome
  bot.command("start", async (ctx) => {
    await ctx.reply(`OpenCode\n\n📁 ${process.cwd()}\n\nJust send a message to start.`, {
      reply_markup: idleKeyboard(),
    });
  });


  // Message handler (skip commands)
  bot.on("message:text", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;

    // Skip commands - they're handled by bot.command()
    if (ctx.message.text.startsWith("/")) return;

    // Get/create session first so we have the ID for the abort button
    let sessionId = userSessions.get(uid);
    if (!sessionId) {
      const session = await createNewSessionForUser({
        opencode,
        userId: uid,
        username: ctx.from?.username,
      });
      sessionId = session?.id;
    }
    if (!sessionId) {
      await ctx.reply("Failed to create session.");
      return;
    }

    // Instant feedback with abort button
    const msg = await ctx.reply("💭 Thinking...", {
      reply_markup: abortKeyboard(),
    });

    void streamSession({
      opencode,
      api: ctx.api,
      sessionId,
      chatId: ctx.chat.id,
      messageId: msg.message_id,
      userId: uid,
      userText: ctx.message.text,
    });
  });

  // Shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    bot.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Starting Telegram bot...");
  bot.start();
  console.log("Bot running! Message your bot on Telegram.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
