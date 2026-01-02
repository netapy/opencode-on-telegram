import { Bot, InlineKeyboard, type Api } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import telegramifyMarkdown from "telegramify-markdown";
import * as path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
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
  type FilePartInput,
  type TextPartInput,
  type Todo,
  type Part,
  type Message,
  type McpLocalConfig,
  type McpRemoteConfig,
} from "@opencode-ai/sdk";

// Config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ?.split(",")
  .map(value => value.trim())
  .filter(Boolean)
  .map(Number)
  .filter(id => Number.isFinite(id) && id > 0) ?? [];
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT) || 4097;
const OPENCODE_MCP_CONFIG = process.env.OPENCODE_MCP_CONFIG;
const OPENCODE_DEFAULT_DIR = process.env.OPENCODE_DEFAULT_DIR;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Throttle config
const UPDATE_INTERVAL_MS = 1000;
const MIN_CHARS_DELTA = 30;

// Inline query config
const INLINE_QUERY_TIMEOUT_MS = 12000;
const INLINE_QUERY_MAX_CHARS = 1800;

// Per-chat sessions
const chatSessions = new Map<string, string>();

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
  toolHistory: string[];
  currentTool: string | null;
  text: string;
  statusNote: string | null;
  filesEdited: string[];
  todos: Todo[];
  tokens: { input: number; output: number };
  cost: number;
  modelLabel: string | null;
  pendingPermission: Permission | null;
  aborted: boolean;
}

function createDisplayState(userInput: string): DisplayState {
  return {
    phase: "thinking",
    userInput,
    reasoning: "",
    tools: new Map(),
    toolHistory: [],
    currentTool: null,
    text: "",
    statusNote: null,
    filesEdited: [],
    todos: [],
    tokens: { input: 0, output: 0 },
    cost: 0,
    modelLabel: null,
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

type ModelSelection = {
  providerID: string;
  modelID: string;
};

type AgentMode = "plan" | "build";

type StatusState = {
  messageId: number;
  chatId: number;
  threadId?: number;
  lastText: string;
};

type DirectoryListingEntry = {
  label: string;
  path: string;
};

type DirectoryBrowseState = {
  baseDir: string;
  page: number;
  totalPages: number;
  totalDirs: number;
  entries: DirectoryListingEntry[];
  recents: string[];
  error?: string | null;
};

type BranchCache = {
  value: string;
  updatedAt: number;
};

type UserSettings = {
  model?: ModelSelection;
  agentMode?: AgentMode;
  statusByContext?: Map<string, StatusState>;
  branch?: BranchCache;
  defaultDirectory?: string;
};

type UsageBucket = {
  tokens: number;
  cost: number;
  messages: number;
};

type UsageStats = {
  totalTokens: number;
  totalCost: number;
  totalMessages: number;
  daily: Map<string, UsageBucket>;
  byModel: Map<string, UsageBucket>;
};

type PendingAuth = {
  providerId: string;
  methodIndex: number;
  type: "oauth" | "api";
};

type PendingGitCommand = {
  userId: number;
  args: string[];
  createdAt: number;
};

type ProviderSummary = {
  id: string;
  name: string;
  models: Array<ModelSummary>;
};

type DefaultModels = Record<string, string>;

type ModelSummary = {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  tool_call: boolean;
  status?: string;
};

type RecentModel = {
  providerID: string;
  modelID: string;
  label: string;
  timestamp: number;
};

type ModelMenuState = {
  userId: number;
  view: "providers" | "models";
  providers: Array<ProviderSummary>;
  providerPage: number;
  modelPage: number;
  providerId?: string;
  defaults?: DefaultModels;
};

type ModeMenuState = {
  userId: number;
};

type ReplyContext = {
  api: Api;
  chat: { id: number };
  from?: { username?: string };
  reply: (
    text: string,
    options?: {
      reply_markup?: InlineKeyboard;
      message_thread_id?: number;
      reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
    },
  ) => Promise<{ message_id: number }>;
};

type McpConfigMap = Record<string, McpLocalConfig | McpRemoteConfig>;

const activeMessages = new Map<string, ActiveMessage>();
const menuStates = new Map<string, MenuState>();
const modelMenuStates = new Map<string, ModelMenuState>();
const modeMenuStates = new Map<string, ModeMenuState>();
const sessionTitleCache = new Map<string, string>();
const sessionDirectoryCache = new Map<string, string>();
const contextDirectories = new Map<string, string>();
const recentDirectories = new Map<string, string[]>();
const directoryBrowseStates = new Map<string, DirectoryBrowseState>();
const userSettings = new Map<number, UserSettings>();
const usageStats = new Map<number, UsageStats>();
const pendingApiAuth = new Map<number, PendingAuth>();
const pendingOauthAuth = new Map<number, PendingAuth>();
const pendingGitCommands = new Map<string, PendingGitCommand>();
const pendingNudges = new Map<string, string[]>();
const recentModelsMap = new Map<number, RecentModel[]>();

let cachedEnvDefaultDirectory: string | null | undefined;
let warnedEnvDefaultDirectory = false;

const MAX_RECENT_MODELS = 3;

const EMPTY_INLINE_KEYBOARD = new InlineKeyboard();
const MENU_PAGE_SIZE = 6;
const MODEL_PAGE_SIZE = 6;
const GIT_CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 3500;
const MAX_TODO_ITEMS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const BRANCH_CACHE_MS = 30000;
const POLL_INITIAL_MS = 400;
const POLL_MAX_MS = 5000;
const STABLE_POLL_COUNT = 4;
const MIN_STABLE_MS = 3000;
const WORKING_PING_MS = 60000;
const TELEGRAM_MAX_MESSAGE = 4096;
const TELEGRAM_SAFE_MESSAGE = 3800;
const TELEGRAM_PARSE_MODE = "MarkdownV2" as const;

const MAX_DIR_ENTRIES = 12;
const MAX_RECENT_DIRS = 6;
const MAX_DIR_LABEL = 28;
const MAX_SESSION_LABEL = 48;

const MAX_BREADCRUMB_TOOLS = 8;
const BREADCRUMB_FULL_NAME_COUNT = 3;

const SESSION_DIVIDER = "------------------------------";

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

const GIT_SAFE_COMMANDS = new Set(["status", "log", "diff", "branch", "remote", "show"]);
const GIT_CONFIRM_COMMANDS = new Set([
  "add",
  "commit",
  "stash",
  "push",
  "reset",
  "checkout",
  "switch",
  "restore",
]);
const GIT_USAGE_TEXT = "Usage: /git status | log | diff | changes | branch | remote | show";

const HELP_TEXT = `OpenCode on Telegram

Commands:
/start - Welcome message and status
/menu - Open interactive menu
/status - Show current status panel
/new - Start a new conversation
/cd [path] - Change working directory
/model - Select AI model
/mode - Switch between Plan/Build modes
/auth - Manage provider authentication
/git <cmd> - Run git commands
/diff - Show file changes in session
/compact - Summarize conversation
/cost - Show usage statistics
/help - Show this help message

Tips:
- Send any text to chat with the AI
- Send images or voice messages
- Use the menu for quick access to features
- Nudge the AI by sending messages while it's working

Directory:
- /cd to browse directories
- /cd <path> to jump directly
- /cd reset to clear selection

Git:
- Safe: status, log, diff, branch, remote, show
- /git changes for a quick overview`;

function messageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function getMessageThreadId(ctx: {
  message?: { message_thread_id?: number };
  callbackQuery?: { message?: { message_thread_id?: number } };
}): number | undefined {
  const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  return typeof threadId === "number" && threadId > 0 ? threadId : undefined;
}

function getSessionKey(chat: { id: number; type?: string }, messageThreadId?: number): string {
  if (chat.type === "private" && messageThreadId) {
    return `${chat.id}:${messageThreadId}`;
  }
  return `${chat.id}`;
}

function withThreadId<T extends Record<string, unknown>>(
  options: T | undefined,
  messageThreadId?: number,
): T & { message_thread_id?: number } {
  if (!messageThreadId) return (options ?? {}) as T & { message_thread_id?: number };
  return { ...(options ?? {}), message_thread_id: messageThreadId } as T & { message_thread_id?: number };
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

function formatModelLabel(selection: ModelSelection | null | undefined): string | null {
  if (!selection) return null;
  return `${selection.providerID}/${selection.modelID}`;
}

function getUserSettings(userId: number): UserSettings {
  const existing = userSettings.get(userId);
  if (existing) return existing;
  const fresh: UserSettings = {};
  userSettings.set(userId, fresh);
  return fresh;
}

function getUserModel(userId: number): ModelSelection | null {
  return getUserSettings(userId).model ?? null;
}

function getUserAgentMode(userId: number): AgentMode {
  return getUserSettings(userId).agentMode ?? "build";
}

function setUserAgentMode(userId: number, mode: AgentMode): void {
  const settings = getUserSettings(userId);
  settings.agentMode = mode;
}

function getRecentModels(userId: number): RecentModel[] {
  return recentModelsMap.get(userId) ?? [];
}

function trackRecentModel(userId: number, providerID: string, modelID: string): void {
  const recent = recentModelsMap.get(userId) ?? [];
  const label = `${providerID}/${modelID}`;
  const filtered = recent.filter(m => !(m.providerID === providerID && m.modelID === modelID));
  filtered.unshift({ providerID, modelID, label, timestamp: Date.now() });
  recentModelsMap.set(userId, filtered.slice(0, MAX_RECENT_MODELS));
}

function getContextDirectory(contextKey: string): string | null {
  return contextDirectories.get(contextKey) ?? null;
}

function setContextDirectory(contextKey: string, dir: string | null): void {
  if (dir) {
    contextDirectories.set(contextKey, dir);
  } else {
    contextDirectories.delete(contextKey);
  }
}

function getUserDefaultDirectory(userId: number): string | null {
  return getUserSettings(userId).defaultDirectory ?? null;
}

function setUserDefaultDirectory(userId: number, dir: string | null): void {
  const settings = getUserSettings(userId);
  if (dir) {
    settings.defaultDirectory = dir;
  } else {
    delete settings.defaultDirectory;
  }
}

function trackRecentDirectory(contextKey: string, dir: string): void {
  const recent = recentDirectories.get(contextKey) ?? [];
  const filtered = recent.filter(entry => entry !== dir);
  filtered.unshift(dir);
  recentDirectories.set(contextKey, filtered.slice(0, MAX_RECENT_DIRS));
}

function getSessionDirectoryHint(sessionId?: string | null): string | null {
  if (!sessionId) return null;
  return sessionDirectoryCache.get(sessionId) ?? null;
}

function withSessionDirectory(sessionId?: string | null): { query: { directory: string } } | {} {
  const directory = getSessionDirectoryHint(sessionId);
  return directory ? { query: { directory } } : {};
}

function formatShortPath(dir: string, max = MAX_DIR_LABEL): string {
  const normalized = dir.replace(/\\/g, "/");
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  const tail = parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
  const display = parts.length > 2 ? `…/${tail}` : `/${tail}`;
  if (display.length <= max) return display;
  return `…${display.slice(display.length - (max - 1))}`;
}

function formatSessionDivider(label: string): string {
  return `${SESSION_DIVIDER}\n${label}\n${SESSION_DIVIDER}`;
}

function getHomeDirectory(): string {
  return process.env.HOME ?? process.cwd();
}

function resolveDirectoryInput(input: string, baseDir: string): string {
  if (input === "~") {
    return process.env.HOME ? process.env.HOME : baseDir;
  }
  if (input.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) return path.join(home, input.slice(2));
  }
  if (path.isAbsolute(input)) return input;
  return path.resolve(baseDir, input);
}

async function normalizeDirectoryInput(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  try {
    const resolvedPath = await realpath(resolved);
    return resolvedPath;
  } catch {
    return resolved;
  }
}

async function validateDirectoryInput(input: string, baseDir: string): Promise<{ path?: string; error?: string }> {
  const resolved = resolveDirectoryInput(input, baseDir);
  const info = await stat(resolved).catch(() => null);
  if (!info) {
    return { error: `Directory not found: ${resolved}` };
  }
  if (!info.isDirectory()) {
    return { error: `Not a directory: ${resolved}` };
  }
  return { path: await normalizeDirectoryInput(resolved) };
}

async function getEnvDefaultDirectory(): Promise<string | null> {
  if (!OPENCODE_DEFAULT_DIR) return null;
  if (cachedEnvDefaultDirectory !== undefined) return cachedEnvDefaultDirectory;
  const { path, error } = await validateDirectoryInput(OPENCODE_DEFAULT_DIR, process.cwd());
  if (!path || error) {
    if (!warnedEnvDefaultDirectory) {
      console.warn(`Invalid OPENCODE_DEFAULT_DIR: ${error ?? OPENCODE_DEFAULT_DIR}`);
      warnedEnvDefaultDirectory = true;
    }
    cachedEnvDefaultDirectory = null;
    return null;
  }
  cachedEnvDefaultDirectory = path;
  return path;
}

async function getNewSessionDirectory(params: { contextKey: string; userId?: number }): Promise<string> {
  const { contextKey, userId } = params;
  const preferred = getContextDirectory(contextKey);
  if (preferred) return preferred;
  if (userId) {
    const userDefault = getUserDefaultDirectory(userId);
    if (userDefault) return userDefault;
  }
  const envDefault = await getEnvDefaultDirectory();
  return envDefault ?? getHomeDirectory();
}

async function getCurrentSessionDirectory(opencode: OpencodeClient, sessionId?: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const cached = sessionDirectoryCache.get(sessionId);
  if (cached) return cached;
  try {
    const { data } = await opencode.session.get({
      path: { id: sessionId },
      ...withSessionDirectory(sessionId),
    });
    if (data?.directory) {
      sessionDirectoryCache.set(sessionId, data.directory);
      return data.directory;
    }
  } catch {
    // ignore
  }
  return null;
}

async function getContextBaseDirectory(params: {
  opencode: OpencodeClient;
  contextKey: string;
  sessionId?: string | null;
  userId?: number;
}): Promise<string> {
  const { opencode, contextKey, sessionId, userId } = params;
  const preferred = getContextDirectory(contextKey);
  if (preferred) return preferred;
  if (sessionId) {
    const sessionDir = await getCurrentSessionDirectory(opencode, sessionId);
    if (sessionDir) return sessionDir;
  }
  if (userId) {
    const userDefault = getUserDefaultDirectory(userId);
    if (userDefault) return userDefault;
  }
  const envDefault = await getEnvDefaultDirectory();
  return envDefault ?? getHomeDirectory();
}

async function listSubdirectories(baseDir: string): Promise<string[]> {
  const listing = await readdir(baseDir, { withFileTypes: true });
  return listing
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function getRecentDirectoryEntries(contextKey: string, baseDir: string): Promise<string[]> {
  const recent = recentDirectories.get(contextKey) ?? [];
  const valid: string[] = [];
  for (const dir of recent) {
    if (dir === baseDir) continue;
    const info = await stat(dir).catch(() => null);
    if (!info || !info.isDirectory()) continue;
    valid.push(dir);
  }
  return valid.slice(0, MAX_RECENT_DIRS);
}

function buildDirectoryBrowserText(
  state: DirectoryBrowseState,
  selectedDir: string | null,
  notice?: string,
): string {
  const lines: string[] = [`📁 ${state.baseDir}`];
  if (selectedDir) {
    lines.push(`Selected: ${selectedDir}`);
  }
  if (state.error) {
    lines.push("", `Error: ${state.error}`);
  }
  if (state.totalPages > 1) {
    lines.push(`Page ${state.page + 1}/${state.totalPages} · ${state.totalDirs} folders`);
  } else {
    lines.push(`${state.totalDirs} folders`);
  }
  if (notice) {
    lines.push("", notice);
  }
  lines.push("", "Tip: /cd <path> to jump");
  return lines.join("\n");
}

function buildDirectoryBrowserKeyboard(state: DirectoryBrowseState): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const parent = path.dirname(state.baseDir);
  if (parent && parent !== state.baseDir) {
    keyboard.text("⬆️ ..", "cd:up");
  } else {
    keyboard.text("⬆️ ..", "cd:noop");
  }
  keyboard.text("🏠 ~", "cd:home").row();

  if (state.entries.length === 0) {
    keyboard.text("(empty)", "cd:noop").row();
  } else {
    const columns = 2;
    state.entries.forEach((entry, index) => {
      const label = `📂 ${truncate(entry.label, 18)}`;
      keyboard.text(label, `cd:nav:${index}`);
      if ((index + 1) % columns === 0) keyboard.row();
    });
    if (state.entries.length % columns !== 0) keyboard.row();
  }

  if (state.totalPages > 1) {
    if (state.page > 0) {
      keyboard.text("◀", `cd:page:${state.page - 1}`);
    } else {
      keyboard.text("◀", "cd:noop");
    }
    keyboard.text(`${state.page + 1}/${state.totalPages}`, "cd:noop");
    if (state.page < state.totalPages - 1) {
      keyboard.text("▶", `cd:page:${state.page + 1}`);
    } else {
      keyboard.text("▶", "cd:noop");
    }
    keyboard.row();
  }

  if (state.recents.length > 0) {
    const perRow = 2;
    state.recents.forEach((dir, index) => {
      const label = `⏱ ${formatShortPath(dir, 18)}`;
      keyboard.text(label, `cd:recent:${index}`);
      if ((index + 1) % perRow === 0) keyboard.row();
    });
    if (state.recents.length % perRow !== 0) keyboard.row();
  }

  keyboard
    .text("✅ Select", "cd:select")
    .text("⭐ Default", "cd:setdefault")
    .row()
    .text("🔄 Reset", "cd:reset")
    .text("✖ Close", "cd:close");
  return keyboard;
}

async function buildDirectoryBrowserState(
  contextKey: string,
  baseDir: string,
  page = 0,
): Promise<DirectoryBrowseState> {
  const normalizedBase = await normalizeDirectoryInput(baseDir);
  let subdirs: string[] = [];
  let error: string | null = null;
  try {
    subdirs = await listSubdirectories(normalizedBase);
  } catch (err) {
    error = String(err);
  }

  const totalDirs = subdirs.length;
  const totalPages = Math.max(1, Math.ceil(totalDirs / MAX_DIR_ENTRIES));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * MAX_DIR_ENTRIES;
  const pageDirs = subdirs.slice(start, start + MAX_DIR_ENTRIES);
  const entries = pageDirs.map(name => ({ label: name, path: path.join(normalizedBase, name) }));
  const recents = await getRecentDirectoryEntries(contextKey, normalizedBase);

  const state: DirectoryBrowseState = {
    baseDir: normalizedBase,
    page: safePage,
    totalPages,
    totalDirs,
    entries,
    recents,
    error,
  };
  directoryBrowseStates.set(contextKey, state);
  return state;
}

async function renderDirectoryBrowser(params: {
  contextKey: string;
  baseDir: string;
  page?: number;
  notice?: string;
}): Promise<{ text: string; keyboard: InlineKeyboard; state: DirectoryBrowseState }> {
  const { contextKey, baseDir, page = 0, notice } = params;
  const state = await buildDirectoryBrowserState(contextKey, baseDir, page);
  const selectedDir = getContextDirectory(contextKey);
  const text = buildDirectoryBrowserText(state, selectedDir, notice);
  const keyboard = buildDirectoryBrowserKeyboard(state);
  return { text, keyboard, state };
}

function getDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function getUsageStatsForUser(userId: number): UsageStats {
  const existing = usageStats.get(userId);
  if (existing) return existing;
  const fresh: UsageStats = {
    totalTokens: 0,
    totalCost: 0,
    totalMessages: 0,
    daily: new Map(),
    byModel: new Map(),
  };
  usageStats.set(userId, fresh);
  return fresh;
}

function recordMessage(userId: number, modelLabel: string | null): void {
  const stats = getUsageStatsForUser(userId);
  stats.totalMessages += 1;
  const day = getDateKey();
  const bucket = stats.daily.get(day) ?? { tokens: 0, cost: 0, messages: 0 };
  bucket.messages += 1;
  stats.daily.set(day, bucket);
  if (modelLabel) {
    const modelBucket = stats.byModel.get(modelLabel) ?? { tokens: 0, cost: 0, messages: 0 };
    modelBucket.messages += 1;
    stats.byModel.set(modelLabel, modelBucket);
  }
}

function recordUsage(userId: number, modelLabel: string | null, tokens: number, cost: number): void {
  const stats = getUsageStatsForUser(userId);
  stats.totalTokens += tokens;
  stats.totalCost += cost;
  const day = getDateKey();
  const bucket = stats.daily.get(day) ?? { tokens: 0, cost: 0, messages: 0 };
  bucket.tokens += tokens;
  bucket.cost += cost;
  stats.daily.set(day, bucket);
  if (modelLabel) {
    const modelBucket = stats.byModel.get(modelLabel) ?? { tokens: 0, cost: 0, messages: 0 };
    modelBucket.tokens += tokens;
    modelBucket.cost += cost;
    stats.byModel.set(modelLabel, modelBucket);
  }
}

function getStatusMap(userId: number): Map<string, StatusState> {
  const settings = getUserSettings(userId);
  if (!settings.statusByContext) {
    settings.statusByContext = new Map();
  }
  return settings.statusByContext;
}

function getStatusState(userId: number, contextKey: string): StatusState | null {
  return getStatusMap(userId).get(contextKey) ?? null;
}

function setStatusState(userId: number, contextKey: string, state: StatusState | null): void {
  const map = getStatusMap(userId);
  if (state) {
    map.set(contextKey, state);
  } else {
    map.delete(contextKey);
  }
}

function formatUsageLine(stats: UsageStats | undefined): string {
  if (!stats) return "Usage: 0 tok · $0.000";
  const dayKey = getDateKey();
  const bucket = stats.daily.get(dayKey) ?? { tokens: 0, cost: 0, messages: 0 };
  const tokens = bucket.tokens;
  const cost = bucket.cost;
  const tokenLabel = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  return `Usage (today): ${tokenLabel} tok · $${cost.toFixed(3)}`;
}

async function getBranchName(opencode: OpencodeClient, userId: number, force = false): Promise<string> {
  const settings = getUserSettings(userId);
  const cached = settings.branch;
  const now = Date.now();
  if (!force && cached && now - cached.updatedAt < BRANCH_CACHE_MS) {
    return cached.value;
  }
  try {
    const { data } = await opencode.vcs.get();
    const branch = data?.branch ?? "(no vcs)";
    settings.branch = { value: branch, updatedAt: now };
    return branch;
  } catch {
    return cached?.value ?? "(unknown)";
  }
}

async function buildStatusText(params: {
  opencode: OpencodeClient;
  userId: number;
  contextKey?: string;
  sessionId?: string | null;
}): Promise<string> {
  const { opencode, userId, contextKey, sessionId } = params;
  const sessionTitle = sessionId ? await getCurrentSessionTitle(opencode, sessionId) : null;
  const modelLabel = formatModelLabel(getUserModel(userId)) ?? "default";
  const agentMode = getUserAgentMode(userId);
  const branch = await getBranchName(opencode, userId);
  const usage = usageStats.get(userId);
  const usageLine = formatUsageLine(usage);
  const directory = contextKey
    ? await getContextBaseDirectory({ opencode, contextKey, sessionId, userId })
    : getHomeDirectory();

  const lines = [
    "Status",
    `Session: ${sessionTitle ?? "None"}`,
    `Mode: ${agentMode}`,
    `Model: ${modelLabel}`,
    `Branch: ${branch}`,
    `Directory: ${directory}`,
    usageLine,
  ];

  return lines.join("\n");
}

async function updateStatusPanel(params: {
  opencode: OpencodeClient;
  api: Api;
  userId: number;
  chatId: number;
  contextKey: string;
  messageThreadId?: number;
  force?: boolean;
}): Promise<void> {
  const { opencode, api, userId, chatId, contextKey, messageThreadId, force = false } = params;
  const current = getStatusState(userId, contextKey);
  const sessionId = chatSessions.get(contextKey);
  const rawText = await buildStatusText({ opencode, userId, contextKey, sessionId });
  const formatted = toTelegramMarkdown(rawText);
  const threadId = messageThreadId ?? current?.threadId;

  if (current) {
    if (!force && current.lastText === formatted) return;
    try {
      await api.editMessageText(current.chatId, current.messageId, formatted, {
        reply_markup: EMPTY_INLINE_KEYBOARD,
        parse_mode: TELEGRAM_PARSE_MODE,
      });
      current.lastText = formatted;
      setStatusState(userId, contextKey, current);
    } catch (err) {
      const message = String(err);
      if (message.includes("message is not modified")) {
        return;
      }
      console.error("Status update failed:", message);
      const msg = await api.sendMessage(
        chatId,
        formatted,
        withThreadId({ parse_mode: TELEGRAM_PARSE_MODE }, threadId),
      );
      const nextState: StatusState = {
        messageId: msg.message_id,
        chatId,
        threadId,
        lastText: formatted,
      };
      setStatusState(userId, contextKey, nextState);
    }
    return;
  }

  const msg = await api.sendMessage(
    chatId,
    formatted,
    withThreadId({ parse_mode: TELEGRAM_PARSE_MODE }, threadId),
  );
  const nextState: StatusState = {
    messageId: msg.message_id,
    chatId,
    threadId,
    lastText: formatted,
  };
  setStatusState(userId, contextKey, nextState);
}

async function maybeUpdateStatusPanel(params: {
  opencode: OpencodeClient;
  api: Api;
  userId: number;
  chatId: number;
  contextKey: string;
  messageThreadId?: number;
  forceBranchRefresh?: boolean;
}): Promise<void> {
  const { opencode, api, userId, chatId, contextKey, messageThreadId, forceBranchRefresh = false } = params;
  if (forceBranchRefresh) {
    await getBranchName(opencode, userId, true);
  }
  await updateStatusPanel({ opencode, api, userId, chatId, contextKey, messageThreadId });
}

function truncateOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16))}\n... (truncated)`;
}

function formatCodeBlockMarkdown(text: string): string {
  const trimmed = truncateOutput(text);
  // In MarkdownV2 code blocks, only ` and \ need escaping inside ```
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  return `\`\`\`\n${escaped}\n\`\`\``;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMessageError(error: unknown): string {
  if (!error) return "Unknown error.";
  const maybeMessage = (error as { data?: { message?: string } }).data?.message;
  if (maybeMessage) return maybeMessage;
  return "Request failed.";
}

// Clamp raw markdown before escaping (escaping can expand text ~1.5x)
// Use a conservative limit so escaped version fits in TELEGRAM_MAX_MESSAGE
const RAW_MARKDOWN_SAFE_LIMIT = 2800;

function clampRawMarkdown(text: string): { text: string; truncated: boolean } {
  if (text.length <= RAW_MARKDOWN_SAFE_LIMIT) return { text, truncated: false };
  // Find a good cut point (prefer paragraph, then line, then word boundary)
  let cut = text.lastIndexOf("\n\n", RAW_MARKDOWN_SAFE_LIMIT);
  if (cut < RAW_MARKDOWN_SAFE_LIMIT / 2) cut = text.lastIndexOf("\n", RAW_MARKDOWN_SAFE_LIMIT);
  if (cut < RAW_MARKDOWN_SAFE_LIMIT / 2) cut = text.lastIndexOf(" ", RAW_MARKDOWN_SAFE_LIMIT);
  if (cut < RAW_MARKDOWN_SAFE_LIMIT / 2) cut = RAW_MARKDOWN_SAFE_LIMIT;
  
  // Check for unclosed code fence
  const prefix = text.slice(0, cut);
  const fenceCount = (prefix.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    // Find last fence and cut before it to avoid broken code block
    const lastFence = prefix.lastIndexOf("```");
    if (lastFence > 0) {
      cut = lastFence;
    }
  }
  
  return { text: text.slice(0, cut).trimEnd() + "...", truncated: true };
}

function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/retry after (\d+)/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

function toTelegramMarkdown(text: string): string {
  return telegramifyMarkdown(text ?? "", "escape");
}

async function editMessageWithRetry(params: {
  api: Api;
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: InlineKeyboard;
  parseMode?: "MarkdownV2";
}): Promise<boolean> {
  const { api, chatId, messageId, text, replyMarkup, parseMode } = params;
  const options = {
    reply_markup: replyMarkup,
    ...(parseMode ? { parse_mode: parseMode } : {}),
  };
  try {
    await api.editMessageText(chatId, messageId, text, options);
    return true;
  } catch (err) {
    const message = String(err);
    const retry = parseRetryAfterSeconds(message);
    if (retry) {
      await sleep((retry + 1) * 1000);
      try {
        await api.editMessageText(chatId, messageId, text, options);
        return true;
      } catch (innerErr) {
        console.error("Edit message failed:", innerErr);
        return false;
      }
    }
    if (!message.includes("message is not modified")) {
      console.error("Edit message failed:", message);
    }
    return false;
  }
}

async function sendMessageWithRetry(params: {
  api: Api;
  chatId: number;
  text: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
  parseMode?: "MarkdownV2";
}): Promise<void> {
  const { api, chatId, text, replyMarkup, messageThreadId, parseMode } = params;
  const options = withThreadId({
    reply_markup: replyMarkup,
    ...(parseMode ? { parse_mode: parseMode } : {}),
  }, messageThreadId);
  try {
    await api.sendMessage(chatId, text, options);
  } catch (err) {
    const message = String(err);
    const retry = parseRetryAfterSeconds(message);
    if (retry) {
      await sleep((retry + 1) * 1000);
      await api.sendMessage(chatId, text, options);
      return;
    }
    console.error("Send message failed:", err);
  }
}

// Split raw markdown into chunks that will fit in Telegram messages after escaping
// Use conservative limit since escaping can expand text ~1.5x
function splitRawMarkdown(text: string, max = RAW_MARKDOWN_SAFE_LIMIT): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = remaining.lastIndexOf("\n", max);
    if (cut < max / 2) cut = remaining.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;

    const prefix = remaining.slice(0, cut);
    const fenceCount = (prefix.match(/```/g) ?? []).length;
    if (fenceCount % 2 === 1) {
      const lastFence = prefix.lastIndexOf("```");
      if (lastFence > 0) {
        cut = lastFence;
      }
    }

    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk.length === 0) {
      cut = max;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

const TODO_STATUS_ICONS: Record<string, string> = {
  pending: "⬜",
  in_progress: "🔄",
  completed: "✅",
  cancelled: "⏹",
};

function formatTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "";
  const lines = todos.slice(0, MAX_TODO_ITEMS).map(todo => {
    const icon = TODO_STATUS_ICONS[todo.status] ?? "⬜";
    return `${icon} ${todo.content}`;
  });
  const remaining = todos.length - lines.length;
  if (remaining > 0) lines.push(`… +${remaining} more`);
  return ["📋 Tasks", ...lines].join("\n");
}

function extractTextFromParts(parts: Array<Part>): string {
  const texts = parts
    .filter(part => part.type === "text")
    .map(part => (part as TextPart).text)
    .filter(Boolean);
  return texts.join("\n").trim();
}

function parseCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function getActiveEntryForSession(sessionId: string | null | undefined): ActiveMessage | null {
  if (!sessionId) return null;
  for (const entry of activeMessages.values()) {
    if (entry.sessionId === sessionId) {
      return entry;
    }
  }
  return null;
}

function queueNudge(sessionId: string, text: string): void {
  const current = pendingNudges.get(sessionId) ?? [];
  current.push(text);
  pendingNudges.set(sessionId, current);
}

function takeQueuedNudges(sessionId: string): string | null {
  const items = pendingNudges.get(sessionId);
  if (!items || items.length === 0) return null;
  pendingNudges.delete(sessionId);
  return items.join("\n");
}

async function sendNudge(params: {
  opencode: OpencodeClient;
  sessionId: string;
  text: string;
}): Promise<void> {
  const { opencode, sessionId, text } = params;
  await opencode.session.promptAsync({
    path: { id: sessionId },
    ...withSessionDirectory(sessionId),
    body: {
      noReply: true,
      parts: [{ type: "text", text }],
    },
  });
}

function parseJsonEnv<T>(value?: string): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    console.error("Failed to parse JSON env:", err);
    return null;
  }
}

// Non-destructive tools that don't need permission
const AUTO_ALLOW_TYPES = new Set(["read", "glob", "grep", "todoread", "webfetch"]);

function shouldAutoAllow(permission: Permission): boolean {
  return AUTO_ALLOW_TYPES.has(permission.type);
}

function stringifyCommandParts(parts: string[]): string {
  return parts.map(part => (part.includes(" ") ? `"${part}"` : part)).join(" ");
}

function extractPermissionCommand(metadata: Record<string, unknown>): string | null {
  const asString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const asStringArray = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return items.length > 0 ? items : null;
  };
  const command = asString(metadata.command)
    ?? asString(metadata.cmd)
    ?? asString(metadata.program)
    ?? asString(metadata.executable)
    ?? asString(metadata.tool)
    ?? null;
  const args = asStringArray(metadata.args)
    ?? asStringArray(metadata.arguments)
    ?? null;
  const input = asString(metadata.input) ?? asString(metadata.text) ?? null;

  if (command && args) return stringifyCommandParts([command, ...args]);
  if (command && input) return `${command} ${input}`.trim();
  if (input) return input;
  if (command) return command;
  if (args) return stringifyCommandParts(args);
  return null;
}

function formatPermissionRequest(permission: Permission): string {
  const icon = PERMISSION_ICONS[permission.type] ?? "🔐";
  const lines = [`${icon} ${permission.title}`];
  const metadata = permission.metadata as Record<string, unknown>;
  const command = extractPermissionCommand(metadata);
  if (command) {
    const truncated = command.length > 300 ? `${command.slice(0, 297)}...` : command;
    lines.push(`Command: ${truncated}`);
  }
  return lines.join("\n");
}

function formatToolStatus(tool: { name: string; title: string; status: string }): string {
  const statusIcon = tool.status === "completed" ? "✓" : tool.status === "error" ? "✗" : "…";
  const toolIcon = TOOL_ICONS[tool.name] ?? "🔧";
  return `${toolIcon} ${tool.title || tool.name} ${statusIcon}`;
}

type BreadcrumbItem = {
  name: string;
  count: number;
};

function dedupeConsecutiveTools(tools: string[]): BreadcrumbItem[] {
  const result: BreadcrumbItem[] = [];
  for (const tool of tools) {
    const last = result[result.length - 1];
    if (last && last.name === tool) {
      last.count += 1;
    } else {
      result.push({ name: tool, count: 1 });
    }
  }
  return result;
}

function formatToolBreadcrumb(toolHistory: string[], currentTool: string | null): string {
  if (toolHistory.length === 0 && !currentTool) return "";

  // Dedupe consecutive tools
  let items = dedupeConsecutiveTools(toolHistory);

  // Truncate in the middle if too many
  if (items.length > MAX_BREADCRUMB_TOOLS) {
    const keepStart = Math.ceil(MAX_BREADCRUMB_TOOLS / 2);
    const keepEnd = Math.floor(MAX_BREADCRUMB_TOOLS / 2);
    const start = items.slice(0, keepStart);
    const end = items.slice(-keepEnd);
    items = [...start, { name: "…", count: 1 }, ...end];
  }

  // Format each item
  const formatted = items.map((item, index) => {
    if (item.name === "…") return "…";

    const icon = TOOL_ICONS[item.name] ?? "🔧";
    const showFullName = index < BREADCRUMB_FULL_NAME_COUNT;
    const countSuffix = item.count > 2 ? ` x${item.count}` : "";

    if (showFullName) {
      return `${icon} ${item.name}${countSuffix}`;
    }
    return `${icon}${countSuffix}`;
  });

  let result = formatted.join(" → ");

  // Add current tool indicator
  if (currentTool) {
    const icon = TOOL_ICONS[currentTool] ?? "🔧";
    const lastItem = items[items.length - 1];
    if (lastItem && lastItem.name === currentTool) {
      // Current tool is same as last completed, add "..."
      result += "...";
    } else {
      // New tool in progress
      const showFullName = items.length < BREADCRUMB_FULL_NAME_COUNT;
      if (result) result += " → ";
      if (showFullName) {
        result += `${icon} ${currentTool}...`;
      } else {
        result += `${icon}...`;
      }
    }
  }

  return result;
}

function renderDisplay(state: DisplayState): string {
  if (state.aborted) return "⏹ Stopped.";

  if (state.phase === "permission" && state.pendingPermission) {
    return formatPermissionRequest(state.pendingPermission);
  }

  // Build breadcrumb line
  const breadcrumb = formatToolBreadcrumb(state.toolHistory, state.currentTool);

  if (state.text) {
    return breadcrumb ? `${breadcrumb}\n\n${state.text}` : state.text;
  }

  const sections: string[] = [];

  // Add breadcrumb as first section if available
  if (breadcrumb) {
    sections.push(breadcrumb);
  }

  const todoSection = formatTodoList(state.todos);
  if (todoSection) sections.push(todoSection);

  if (state.phase === "reasoning" && state.reasoning) {
    sections.push(`🧠 ${truncate(state.reasoning, 200)}`);
  } else if (state.phase === "tools") {
    const lines = [...state.tools.values()].map(formatToolStatus);
    sections.push(lines.length > 0 ? lines.join("\n") : "⚙️ Working...");
  } else {
    sections.push("💭 Thinking...");
  }

  if (state.statusNote) {
    sections.push(state.statusNote);
  }

  return sections.join("\n\n");
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

  // Breadcrumb of tools used
  const breadcrumb = formatToolBreadcrumb(state.toolHistory, null);
  if (breadcrumb) {
    sections.push(breadcrumb, "");
  }

  const todoSection = formatTodoList(state.todos);
  if (todoSection) sections.push(todoSection, "");

  if (state.text) {
    sections.push(state.text);
  }

  const footerParts: string[] = [];

  if (state.modelLabel) {
    footerParts.push(state.modelLabel);
  }

  if (state.tokens.input + state.tokens.output > 0) {
    const total = ((state.tokens.input + state.tokens.output) / 1000).toFixed(1);
    footerParts.push(`${total}k`);
  }
  if (state.cost > 0) {
    footerParts.push(`$${state.cost.toFixed(3)}`);
  }

  if (footerParts.length > 0) {
    sections.push(`\n⟪ ${footerParts.join(" · ")} ⟫`);
  }

  return sections.join("\n") || "Done.";
}

function updateSessionCache(sessions: Session[]): void {
  for (const session of sessions) {
    sessionTitleCache.set(session.id, session.title);
    if (session.directory) {
      sessionDirectoryCache.set(session.id, session.directory);
    }
  }
}

async function getCurrentSessionTitle(opencode: OpencodeClient, sessionId?: string): Promise<string | null> {
  if (!sessionId) return null;
  const cached = sessionTitleCache.get(sessionId);
  if (cached) return cached;
  try {
    const { data } = await opencode.session.get({
      path: { id: sessionId },
      ...withSessionDirectory(sessionId),
    });
    if (data?.title) {
      sessionTitleCache.set(sessionId, data.title);
      return data.title;
    }
    // No title yet - try to get first message as fallback
    const { data: messages } = await opencode.session.messages({
      path: { id: sessionId },
      ...withSessionDirectory(sessionId),
    });
    const firstUserMessage = (messages ?? []).find(m => m.info.role === "user");
    if (firstUserMessage) {
      const textPart = firstUserMessage.parts.find(p => p.type === "text") as TextPart | undefined;
      if (textPart?.text) {
        return truncate(textPart.text, 30);
      }
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

function menuMainText(currentTitle: string | null, currentModel: string | null, currentMode: AgentMode, currentDirectory?: string): string {
  const modelLabel = currentModel ?? "default";
  const dirLabel = currentDirectory ? formatShortPath(currentDirectory) : "default";
  return `Menu\n${formatCurrentLabel(currentTitle)}\nModel: ${modelLabel}\nMode: ${currentMode}\nDirectory: ${dirLabel}`;
}

function menuMainKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("📊 Status", "menu:status")
    .text("🗂 Sessions", "menu:sessions")
    .row()
    .text("✨ New", "menu:new")
    .text("🧹 Clear", "menu:clear")
    .row()
    .text("📁 Directory", "menu:cd")
    .text("🤖 Model", "menu:model")
    .row()
    .text("🧭 Mode", "menu:mode")
    .text("🔐 Auth", "menu:auth")
    .row()
    .text("🧾 Git", "menu:git")
    .text("📄 Diff", "menu:diff")
    .row()
    .text("🗜 Compact", "menu:compact")
    .text("💸 Cost", "menu:cost")
    .row()
    .text("✖ Close", "menu:close");
  return keyboard;
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

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatSessionLabel(session: Session, isCurrent: boolean): string {
  const prefix = isCurrent ? "• " : "";
  const time = formatRelativeTime(session.time.updated);
  const title = session.title || session.id.slice(0, 8);
  const summary = session.summary;
  let suffix = "";
  if (summary && (summary.additions > 0 || summary.deletions > 0)) {
    suffix = ` (+${summary.additions}/-${summary.deletions})`;
  }
  const directory = session.directory ? ` · 📁 ${formatShortPath(session.directory)}` : "";
  return truncate(`${prefix}${title} · ${time}${suffix}${directory}`, MAX_SESSION_LABEL);
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
      const label = formatSessionLabel(session, isCurrent);
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
}): Promise<boolean> {
  const { api, chatId, messageId, text, keyboard, state } = params;
  const key = messageKey(chatId, messageId);
  menuStates.set(key, state);
  try {
    await api.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
    return true;
  } catch (err) {
    const message = String(err);
    if (message.includes("message is not modified")) return true;
    console.error("Menu update failed:", message);
    return false;
  }
}

async function sendMenuMessage(params: {
  api: Api;
  chatId: number;
  text: string;
  keyboard: InlineKeyboard;
  state: MenuState;
  messageThreadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { api, chatId, text, keyboard, state, messageThreadId, replyToMessageId } = params;
  const reply_parameters = replyToMessageId
    ? { message_id: replyToMessageId, allow_sending_without_reply: true }
    : undefined;
  const msg = await api.sendMessage(
    chatId,
    text,
    withThreadId({ reply_markup: keyboard, reply_parameters }, messageThreadId),
  );
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
  await closeModelMenusForUser({ api, userId });
  await closeModeMenusForUser({ api, userId });
}

async function openMenu(params: {
  api: Api;
  opencode: OpencodeClient;
  chatId: number;
  userId: number;
  contextKey: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { api, opencode, chatId, userId, contextKey, messageThreadId, replyToMessageId } = params;
  const currentSessionId = chatSessions.get(contextKey);
  const currentTitle = await getCurrentSessionTitle(opencode, currentSessionId);
  const currentModel = formatModelLabel(getUserModel(userId));
  const currentMode = getUserAgentMode(userId);
  const currentDirectory = await getContextBaseDirectory({
    opencode,
    contextKey,
    sessionId: currentSessionId,
    userId,
  });
  const text = menuMainText(currentTitle, currentModel, currentMode, currentDirectory);
  const keyboard = menuMainKeyboard();

  await sendMenuMessage({
    api,
    chatId,
    text,
    keyboard,
    state: { userId, page: 0, sessionIds: [] },
    messageThreadId,
    replyToMessageId,
  });
}

async function updateModelMessage(params: {
  api: Api;
  chatId: number;
  messageId: number;
  text: string;
  keyboard: InlineKeyboard;
  state: ModelMenuState;
}): Promise<void> {
  const { api, chatId, messageId, text, keyboard, state } = params;
  const key = messageKey(chatId, messageId);
  modelMenuStates.set(key, state);
  try {
    await api.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
  } catch (err) {
    const message = String(err);
    if (message.includes("message is not modified")) return;
    console.error("Model menu update failed:", message);
  }
}

async function sendModelMessage(params: {
  api: Api;
  chatId: number;
  text: string;
  keyboard: InlineKeyboard;
  state: ModelMenuState;
  messageThreadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { api, chatId, text, keyboard, state, messageThreadId, replyToMessageId } = params;
  const reply_parameters = replyToMessageId
    ? { message_id: replyToMessageId, allow_sending_without_reply: true }
    : undefined;
  const msg = await api.sendMessage(
    chatId,
    text,
    withThreadId({ reply_markup: keyboard, reply_parameters }, messageThreadId),
  );
  const key = messageKey(chatId, msg.message_id);
  modelMenuStates.set(key, state);
}

async function closeModelMessage(api: Api, chatId: number, messageId: number): Promise<void> {
  await api.deleteMessage(chatId, messageId).catch(async () => {
    await api.editMessageText(chatId, messageId, "Model menu closed.", { reply_markup: EMPTY_INLINE_KEYBOARD }).catch(() => {});
  });
}

function getModelMessageFromCallback(ctx: {
  callbackQuery?: { message?: { message_id: number; chat: { id: number } } };
}): { key: string; chatId: number; messageId: number } | null {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return null;
  const key = messageKey(msg.chat.id, msg.message_id);
  return { key, chatId: msg.chat.id, messageId: msg.message_id };
}

async function closeModelMenusForUser(params: { api: Api; userId: number }): Promise<void> {
  const { api, userId } = params;
  const entries = [...modelMenuStates.entries()].filter(([, state]) => state.userId === userId);
  await Promise.all(entries.map(async ([key]) => {
    modelMenuStates.delete(key);
    const parsed = parseMessageKey(key);
    if (!parsed) return;
    const { chatId, messageId } = parsed;
    await closeModelMessage(api, chatId, messageId);
  }));
}

async function fetchProviders(opencode: OpencodeClient): Promise<{ providers: ProviderSummary[]; defaults?: DefaultModels }> {
  const { data } = await opencode.provider.list();
  const providers = (data?.all ?? []).map(provider => {
    const models = Object.values(provider.models ?? {}).map(model => ({
      id: model.id,
      name: model.name,
      attachment: model.attachment,
      reasoning: model.reasoning,
      tool_call: model.tool_call,
      status: model.status,
    }));
    return { id: provider.id, name: provider.name, models };
  });
  return { providers };
}

function buildProviderMenu(params: {
  providers: Array<ProviderSummary>;
  page: number;
  currentModel: string | null;
  recentModels: RecentModel[];
  defaults?: DefaultModels;
}): { text: string; keyboard: InlineKeyboard; page: number } {
  const { providers, currentModel, recentModels } = params;
  const totalPages = Math.max(1, Math.ceil(providers.length / MODEL_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(params.page, 0), totalPages - 1);
  const start = pageIndex * MODEL_PAGE_SIZE;
  const pageProviders = providers.slice(start, start + MODEL_PAGE_SIZE);

  const textLines = ["Model selection", `Current: ${currentModel ?? "default"}`];
  const keyboard = new InlineKeyboard();

  if (recentModels.length > 0) {
    textLines.push("", "Recent:");
    recentModels.slice(0, MAX_RECENT_MODELS).forEach((model, index) => {
      const label = truncate(model.label, 28);
      keyboard.text(label, `model:recent:${index}`);
      keyboard.row();
    });
  }

  if (pageProviders.length === 0) {
    keyboard.text("(empty)", "model:noop").row();
  } else {
    pageProviders.forEach((provider, index) => {
      const label = truncate(provider.name, 28);
      keyboard.text(label, `model:provider:${index}`);
      keyboard.row();
    });
  }

  if (totalPages > 1) {
    keyboard.text("◀", "model:prev");
    keyboard.text(`${pageIndex + 1}/${totalPages}`, "model:noop");
    keyboard.text("▶", "model:next");
    keyboard.row();
  }

  keyboard.text("✖ Close", "model:close");

  return { text: textLines.join("\n"), keyboard, page: pageIndex };
}

function buildModelsMenu(params: {
  provider: ProviderSummary;
  page: number;
  currentModel: string | null;
}): { text: string; keyboard: InlineKeyboard; page: number } {
  const { provider, currentModel } = params;
  const totalPages = Math.max(1, Math.ceil(provider.models.length / MODEL_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(params.page, 0), totalPages - 1);
  const start = pageIndex * MODEL_PAGE_SIZE;
  const pageModels = provider.models.slice(start, start + MODEL_PAGE_SIZE);

  const textLines = [`${provider.name} models`, `Current: ${currentModel ?? "default"}`];
  const keyboard = new InlineKeyboard();

  if (pageModels.length === 0) {
    keyboard.text("(empty)", "model:noop").row();
  } else {
    pageModels.forEach((model, index) => {
      const label = truncate(model.name, 28);
      keyboard.text(label, `model:choose:${index}`);
      keyboard.row();
    });
  }

  if (totalPages > 1) {
    keyboard.text("◀", "model:prev");
    keyboard.text(`${pageIndex + 1}/${totalPages}`, "model:noop");
    keyboard.text("▶", "model:next");
    keyboard.row();
  }

  keyboard.text("⬅ Back", "model:back").text("✖ Close", "model:close");

  return { text: textLines.join("\n"), keyboard, page: pageIndex };
}

async function openModelMenu(params: {
  api: Api;
  opencode: OpencodeClient;
  chatId: number;
  userId: number;
  messageThreadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { api, opencode, chatId, userId, messageThreadId, replyToMessageId } = params;
  const { providers, defaults } = await fetchProviders(opencode);
  const currentModel = formatModelLabel(getUserModel(userId));
  const recentModels = getRecentModels(userId);
  const menu = buildProviderMenu({ providers, page: 0, currentModel, recentModels, defaults });
  await sendModelMessage({
    api,
    chatId,
    text: menu.text,
    keyboard: menu.keyboard,
    state: {
      userId,
      view: "providers",
      providers,
      providerPage: menu.page,
      modelPage: 0,
      defaults,
    },
    messageThreadId,
    replyToMessageId,
  });
}

function modeMenuText(currentMode: AgentMode): string {
  return `Mode selection\nCurrent: ${currentMode}`;
}

function modeMenuKeyboard(currentMode: AgentMode): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const planLabel = currentMode === "plan" ? "✅ Plan" : "Plan";
  const buildLabel = currentMode === "build" ? "✅ Build" : "Build";
  keyboard.text(planLabel, "mode:plan").row();
  keyboard.text(buildLabel, "mode:build").row();
  keyboard.text("☰ Menu", "menu").text("✖ Close", "mode:close");
  return keyboard;
}

function getModeMessageFromCallback(ctx: {
  callbackQuery?: { message?: { message_id: number; chat: { id: number } } };
}): { key: string; chatId: number; messageId: number } | null {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return null;
  const key = messageKey(msg.chat.id, msg.message_id);
  return { key, chatId: msg.chat.id, messageId: msg.message_id };
}

async function sendModeMessage(params: {
  api: Api;
  chatId: number;
  currentMode: AgentMode;
  userId: number;
  messageThreadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { api, chatId, currentMode, userId, messageThreadId, replyToMessageId } = params;
  const reply_parameters = replyToMessageId
    ? { message_id: replyToMessageId, allow_sending_without_reply: true }
    : undefined;
  const keyboard = modeMenuKeyboard(currentMode);
  const msg = await api.sendMessage(
    chatId,
    modeMenuText(currentMode),
    withThreadId({ reply_markup: keyboard, reply_parameters }, messageThreadId),
  );
  const key = messageKey(chatId, msg.message_id);
  modeMenuStates.set(key, { userId });
}

async function closeModeMessage(api: Api, chatId: number, messageId: number): Promise<void> {
  await api.deleteMessage(chatId, messageId).catch(async () => {
    await api.editMessageText(chatId, messageId, "Mode menu closed.", { reply_markup: EMPTY_INLINE_KEYBOARD }).catch(() => {});
  });
}

async function closeModeMenusForUser(params: { api: Api; userId: number }): Promise<void> {
  const { api, userId } = params;
  const entries = [...modeMenuStates.entries()].filter(([, state]) => state.userId === userId);
  await Promise.all(entries.map(async ([key]) => {
    modeMenuStates.delete(key);
    const parsed = parseMessageKey(key);
    if (!parsed) return;
    const { chatId, messageId } = parsed;
    await closeModeMessage(api, chatId, messageId);
  }));
}

async function openModeMenu(params: {
  api: Api;
  chatId: number;
  userId: number;
  messageThreadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { api, chatId, userId, messageThreadId, replyToMessageId } = params;
  const currentMode = getUserAgentMode(userId);
  await sendModeMessage({ api, chatId, currentMode, userId, messageThreadId, replyToMessageId });
}

async function sendAuthMenu(params: {
  api: Api;
  opencode: OpencodeClient;
  chatId: number;
  messageThreadId?: number;
}): Promise<void> {
  const { api, opencode, chatId, messageThreadId } = params;
  const { data: providerData } = await opencode.provider.list();
  const { data: authData } = await opencode.provider.auth();
  const providers = providerData?.all ?? [];
  const authMap = (authData ?? {}) as Record<string, Array<{ type: "oauth" | "api"; label: string }>>;

  if (providers.length === 0) {
    await api.sendMessage(chatId, "No providers available.", withThreadId({}, messageThreadId));
    return;
  }

  const keyboard = new InlineKeyboard();
  let count = 0;
  providers.forEach(provider => {
    const methods = authMap[provider.id] ?? [];
    methods.forEach((method, index) => {
      const label = truncate(`${provider.name} (${method.label})`, 40);
      keyboard.text(label, `auth:${method.type}:${provider.id}:${index}`).row();
      count += 1;
    });
  });

  if (count === 0) {
    await api.sendMessage(chatId, "No providers expose auth methods.", withThreadId({}, messageThreadId));
    return;
  }

  keyboard.text("✖ Close", "auth:close");
  await api.sendMessage(
    chatId,
    "Choose a provider to connect:",
    withThreadId({ reply_markup: keyboard }, messageThreadId),
  );
}

async function sendGitUsage(params: {
  api: Api;
  chatId: number;
  messageThreadId?: number;
}): Promise<void> {
  const { api, chatId, messageThreadId } = params;
  await api.sendMessage(chatId, GIT_USAGE_TEXT, withThreadId({}, messageThreadId));
}

async function sendSessionDiff(params: {
  api: Api;
  opencode: OpencodeClient;
  chatId: number;
  contextKey: string;
  messageThreadId?: number;
}): Promise<void> {
  const { api, opencode, chatId, contextKey, messageThreadId } = params;
  const sessionId = chatSessions.get(contextKey);
  if (!sessionId) {
    await api.sendMessage(chatId, "No active session.", withThreadId({}, messageThreadId));
    return;
  }
  const { data } = await opencode.session.diff({
    path: { id: sessionId },
    ...withSessionDirectory(sessionId),
  });
  const diffs = data ?? [];
  if (diffs.length === 0) {
    await api.sendMessage(chatId, "No changes in this session yet.", withThreadId({}, messageThreadId));
    return;
  }
  const lines = diffs.map(diff => `${diff.file}\n  +${diff.additions} -${diff.deletions}`);
  const totalAdditions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
  const totalDeletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0);
  const summary = `Session changes\n\n${lines.join("\n")}`;
  const totals = `\n\nTotal: +${totalAdditions} -${totalDeletions}`;
  await api.sendMessage(
    chatId,
    formatCodeBlockMarkdown(`${summary}${totals}`),
    withThreadId({ parse_mode: TELEGRAM_PARSE_MODE }, messageThreadId),
  );
}

async function compactSession(params: {
  api: Api;
  opencode: OpencodeClient;
  chatId: number;
  contextKey: string;
  messageThreadId?: number;
}): Promise<void> {
  const { api, opencode, chatId, contextKey, messageThreadId } = params;
  const sessionId = chatSessions.get(contextKey);
  if (!sessionId) {
    await api.sendMessage(chatId, "No active session to compact.", withThreadId({}, messageThreadId));
    return;
  }
  const msg = await api.sendMessage(
    chatId,
    "🗜 Compacting conversation...\n▱▱▱▱▱",
    withThreadId({}, messageThreadId),
  );
  const frames = ["▱▱▱▱▱", "▰▱▱▱▱", "▰▰▱▱▱", "▰▰▰▱▱", "▰▰▰▰▱", "▰▰▰▰▰"];
  let frameIndex = 0;
  const timer = setInterval(async () => {
    frameIndex = (frameIndex + 1) % frames.length;
    await api.editMessageText(chatId, msg.message_id, `🗜 Compacting conversation...\n${frames[frameIndex]}`).catch(() => {});
  }, 700);

  try {
    await opencode.session.summarize({
      path: { id: sessionId },
      ...withSessionDirectory(sessionId),
    });
    await api.editMessageText(chatId, msg.message_id, "✅ Compacted. Use /diff to review changes.").catch(() => {});
  } catch (err) {
    console.error("Compaction failed:", err);
    await api.editMessageText(chatId, msg.message_id, "Compaction failed.").catch(() => {});
  } finally {
    clearInterval(timer);
  }
}

async function sendCostSummary(params: {
  api: Api;
  userId: number;
  chatId: number;
  messageThreadId?: number;
}): Promise<void> {
  const { api, userId, chatId, messageThreadId } = params;
  const stats = usageStats.get(userId);
  if (!stats || stats.totalMessages === 0) {
    await api.sendMessage(chatId, "No usage recorded yet.", withThreadId({}, messageThreadId));
    return;
  }
  const todayKey = getDateKey();
  const today = stats.daily.get(todayKey) ?? { tokens: 0, cost: 0, messages: 0 };
  const modelLines = [...stats.byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 3)
    .map(([model, data]) => `• ${model}: ${data.cost.toFixed(3)}$ (${data.tokens} tok)`);

  const lines = [
    "📊 Usage",
    "",
    `Today (${todayKey}): ${today.tokens} tok · $${today.cost.toFixed(3)} · ${today.messages} msgs`,
    `Total: ${stats.totalTokens} tok · $${stats.totalCost.toFixed(3)} · ${stats.totalMessages} msgs`,
  ];
  if (modelLines.length > 0) {
    lines.push("", "Top models:", ...modelLines);
  }
  await api.sendMessage(chatId, lines.join("\n"), withThreadId({}, messageThreadId));
}

async function runGitCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function formatGitSection(title: string, lines: Array<string>): string {
  if (lines.length === 0) return "";
  return `${title}\n${lines.join("\n")}`;
}

function formatGitChanges(params: {
  status: string;
  diffStat: string;
  diffCachedStat: string;
}): string {
  const { status, diffStat, diffCachedStat } = params;
  const sections: string[] = [];
  const statusLines = status.split("\n").filter(Boolean);
  if (statusLines.length > 0) {
    sections.push(statusLines.join("\n"));
  }
  if (diffCachedStat.trim()) {
    sections.push(`Staged diff:\n${diffCachedStat.trim()}`);
  }
  if (diffStat.trim()) {
    sections.push(`Working diff:\n${diffStat.trim()}`);
  }
  return sections.join("\n\n") || "(no changes)";
}

async function fetchTelegramFile(api: Api, fileId: string): Promise<Buffer> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("File path missing");
  }
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file (${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

function toDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function transcribeVoice(buffer: Buffer): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([buffer], { type: "audio/ogg" }), "voice.ogg");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Transcription failed (${response.status}): ${text}`);
  }
  const data = await response.json() as { text?: string };
  return data.text?.trim() ?? "";
}

async function abortActiveStreamsForSession(params: {
  sessionId: string;
  opencode: OpencodeClient;
  api: Api;
}): Promise<void> {
  const { sessionId, opencode, api } = params;
  const sessionQuery = withSessionDirectory(sessionId);
  const entries = [...activeMessages.entries()].filter(([, entry]) => entry.sessionId === sessionId);
  await Promise.all(entries.map(async ([key, entry]) => {
    entry.state.aborted = true;
    entry.resolvePermission?.();
    entry.resolvePermission = undefined;
    entry.abortController.abort();
    void opencode.session.abort({ path: { id: entry.sessionId }, ...sessionQuery }).catch(() => {});
    const parsed = parseMessageKey(key);
    if (parsed) {
      await api.editMessageText(parsed.chatId, parsed.messageId, "⏹ Stopped.", { reply_markup: idleKeyboard() }).catch(() => {});
    }
    activeMessages.delete(key);
  }));
}

async function createNewSessionForChat(params: {
  opencode: OpencodeClient;
  contextKey: string;
  userId?: number;
}): Promise<Session | null> {
  const { opencode, contextKey, userId } = params;
  const directory = await getNewSessionDirectory({ contextKey, userId });
  try {
    const { data } = await opencode.session.create({
      body: {},
      query: { directory },
    });
    if (!data?.id) {
      console.error("Session create returned no ID:", data);
      return null;
    }

    chatSessions.set(contextKey, data.id);
    if (data.directory) {
      sessionDirectoryCache.set(data.id, data.directory);
    }
    return data;
  } catch (err) {
    console.error("Session create failed:", err);
    return null;
  }
}

async function ensureSessionId(params: {
  opencode: OpencodeClient;
  contextKey: string;
  userId?: number;
}): Promise<string | null> {
  const { opencode, contextKey, userId } = params;
  let sessionId = chatSessions.get(contextKey);
  if (!sessionId) {
    const session = await createNewSessionForChat({ opencode, contextKey, userId });
    sessionId = session?.id;
  }
  return sessionId ?? null;
}

function buildTextParts(text: string): Array<TextPartInput> {
  return [{ type: "text", text }];
}

async function startStreamingReply(params: {
  opencode: OpencodeClient;
  ctx: ReplyContext;
  userId: number;
  userText: string;
  parts: Array<TextPartInput | FilePartInput>;
  contextKey: string;
  messageThreadId?: number;
  initialText?: string;
}): Promise<void> {
  const { opencode, ctx, userId, userText, parts, contextKey, messageThreadId, initialText } = params;
  const sessionId = await ensureSessionId({ opencode, contextKey, userId });
  if (!sessionId) {
    await ctx.reply("Failed to create session.", withThreadId(undefined, messageThreadId));
    return;
  }
  const msg = await ctx.reply(
    initialText ?? "💭 Thinking...",
    withThreadId({ reply_markup: abortKeyboard() }, messageThreadId),
  );
  const model = getUserModel(userId);
  const agent = getUserAgentMode(userId);
  await streamSession({
    opencode,
    api: ctx.api,
    sessionId,
    chatId: ctx.chat.id,
    messageId: msg.message_id,
    userId,
    userText,
    parts,
    model,
    agent,
    contextKey,
    messageThreadId,
  });
}

async function streamSession(params: {
  opencode: OpencodeClient;
  api: Api;
  sessionId: string;
  chatId: number;
  messageId: number;
  userId: number;
  userText: string;
  parts: Array<TextPartInput | FilePartInput>;
  model: ModelSelection | null;
  agent: AgentMode;
  contextKey: string;
  messageThreadId?: number;
}): Promise<void> {
  const {
    opencode,
    api,
    sessionId,
    chatId,
    messageId,
    userText,
    userId,
    parts,
    model,
    agent,
    contextKey,
    messageThreadId,
  } = params;
  const state = createDisplayState(userText);
  const modelLabel = formatModelLabel(model);
  state.modelLabel = modelLabel;
  recordMessage(userId, modelLabel);
  if (model) {
    trackRecentModel(userId, model.providerID, model.modelID);
  }
  const handledMessages = new Set<string>();
  let sawStepFinish = false;
  let lastRender = "";
  let lastUpdate = 0;
  let nextEditAllowedAt = 0;
  let lastKeyboardToken: "abort" | "permission" = "abort";
  let usePlainText = false;
  const key = messageKey(chatId, messageId);
  const abortController = new AbortController();

  activeMessages.set(key, { userId, sessionId, state, abortController });

  let typing = true;
  (async () => {
    while (typing) {
      await api.sendChatAction(chatId, "typing", withThreadId(undefined, messageThreadId)).catch(() => {});
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

    if (now < nextEditAllowedAt) return;

    const clamped = clampRawMarkdown(rendered || "...");
    const formatted = usePlainText ? clamped.text : toTelegramMarkdown(clamped.text);
    const contentChanged = formatted !== lastRender;

    if (!force) {
      if (!contentChanged && !keyboardChanged) return;
      if (now - lastUpdate < UPDATE_INTERVAL_MS && !contentChanged && !keyboardChanged) return;
      if (contentChanged && state.text && Math.abs(formatted.length - (lastRender.length || 0)) < MIN_CHARS_DELTA && !keyboardChanged) return;
    } else if (now - lastUpdate < UPDATE_INTERVAL_MS) {
      return;
    }

    try {
      await api.editMessageText(chatId, messageId, formatted, {
        reply_markup: desiredKeyboard,
        ...(usePlainText ? {} : { parse_mode: TELEGRAM_PARSE_MODE }),
      });
      lastRender = formatted;
      lastUpdate = now;
      lastKeyboardToken = desiredToken;
    } catch (err) {
      const message = String(err);
      const retry = parseRetryAfterSeconds(message);
      if (retry) {
        nextEditAllowedAt = now + retry * 1000;
        return;
      }
      if (!usePlainText && message.includes("can't parse entities")) {
        usePlainText = true;
        try {
          await api.editMessageText(chatId, messageId, clamped.text, {
            reply_markup: desiredKeyboard,
          });
          lastRender = clamped.text;
          lastUpdate = now;
          lastKeyboardToken = desiredToken;
          return;
        } catch (fallbackErr) {
          console.error("Edit message failed:", fallbackErr);
          return;
        }
      }
      if (!message.includes("message is not modified")) {
        console.error("Edit message failed:", message);
      }
    }
  };

  try {
    const sessionQuery = withSessionDirectory(sessionId);
    const events = await opencode.event.subscribe({ signal: abortController.signal, ...sessionQuery });
    let promptError: string | null = null;
    const promptPromise = opencode.session.prompt({
      path: { id: sessionId },
      ...sessionQuery,
      body: {
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
        parts,
      }
    }).then(response => response.data ?? null).catch(err => {
      console.error("Prompt failed:", err);
      promptError = err instanceof Error ? err.message : String(err);
      return null;
    });

    const pollPromise = (async () => {
      const promptData = await promptPromise;
      if (state.aborted) return;

      const promptRecord = promptData && typeof promptData === "object"
        ? (promptData as Record<string, unknown>)
        : null;
      const promptInfo = (promptRecord?.info as Message | undefined);
      const assistantInfo = promptInfo && promptInfo.role === "assistant" ? promptInfo : null;
      const promptParts = Array.isArray(promptRecord?.parts) ? (promptRecord?.parts as Part[]) : [];

      if (!assistantInfo?.id) {
        if (!state.aborted) {
          let errorDetail: string | null = promptError;
          if (!errorDetail && promptRecord) {
            if (promptRecord.error) {
              errorDetail = String(promptRecord.error);
            } else if (promptRecord.message) {
              errorDetail = String(promptRecord.message);
            }
          }
          if (errorDetail) {
            state.phase = "responding";
            state.text = `⚠️ Error: ${errorDetail}`;
            state.statusNote = null;
            await update(true);
            abortController.abort();
            return;
          }
          console.warn("Prompt returned no message info; waiting for event stream.");
          state.statusNote = "⏳ Waiting for response...";
          await update(true);
        }
        return;
      }

      const messageId = assistantInfo.id;
      let lastText = extractTextFromParts(promptParts);
      let stableCount = 0;
      let delay = POLL_INITIAL_MS;
      let lastPing = Date.now();
      let lastTextChange = Date.now();

      if (!state.modelLabel) {
        state.modelLabel = `${assistantInfo.providerID}/${assistantInfo.modelID}`;
      }

      if (!sawStepFinish && assistantInfo.tokens) {
        state.tokens.input += assistantInfo.tokens.input;
        state.tokens.output += assistantInfo.tokens.output;
        state.cost += assistantInfo.cost ?? 0;
        recordUsage(userId, state.modelLabel, assistantInfo.tokens.input + assistantInfo.tokens.output, assistantInfo.cost ?? 0);
      }

      if (lastText) {
        state.phase = "responding";
        state.text = lastText;
        state.statusNote = null;
        await update(true);
      }

      while (!state.aborted) {
        const { data } = await opencode.session.message({
          path: { id: sessionId, messageID: messageId },
          ...sessionQuery,
        }).catch(() => ({ data: undefined }));

        const info = data?.info as Message | undefined;
        const parts = data?.parts ?? [];
        const text = extractTextFromParts(parts);
        if (text && text !== lastText) {
          lastText = text;
          lastTextChange = Date.now();
          stableCount = 0;
          state.phase = "responding";
          state.text = text;
          state.statusNote = null;
          await update(true);
        } else {
          stableCount += 1;
        }

        if (info && info.role === "assistant") {
          if (!state.modelLabel) {
            state.modelLabel = `${info.providerID}/${info.modelID}`;
          }
          if (!sawStepFinish && info.tokens) {
            state.tokens.input += info.tokens.input;
            state.tokens.output += info.tokens.output;
            state.cost += info.cost ?? 0;
            recordUsage(userId, state.modelLabel, info.tokens.input + info.tokens.output, info.cost ?? 0);
          }
          if (info.time?.completed) break;
        }

        if (stableCount >= STABLE_POLL_COUNT && Date.now() - lastTextChange > MIN_STABLE_MS) break;
        if (Date.now() - lastPing > WORKING_PING_MS) {
          state.statusNote = "⏳ Still working...";
          await update(true);
          lastPing = Date.now();
        }

        delay = Math.min(POLL_MAX_MS, delay * 1.5);
        await sleep(delay);
      }
    })();

    try {
      eventLoop: for await (const event of events.stream as AsyncIterable<Event>) {
        if (state.aborted) break eventLoop;
        if (!("properties" in event)) continue;
        const props = event.properties as Record<string, unknown>;

        const evtSession = (props.sessionID as string)
          ?? ((props.part as Record<string, unknown>)?.sessionID as string)
          ?? ((props.info as Record<string, unknown>)?.sessionID as string);
        if (evtSession && evtSession !== sessionId) continue;

        switch (event.type) {
          case "permission.updated": {
            const permission = props as Permission;
            if (permission.sessionID !== sessionId) break;

            if (shouldAutoAllow(permission)) {
              await opencode.postSessionIdPermissionsPermissionId({
                path: { id: sessionId, permissionID: permission.id },
                ...sessionQuery,
                body: { response: "once" },
              });
              break;
            }

            state.phase = "permission";
            state.pendingPermission = permission;
            await update(true);

            await new Promise<void>((resolve) => {
              const entry = activeMessages.get(key);
              if (!entry) return resolve();
              entry.resolvePermission = resolve;
            });
            if (state.aborted) break eventLoop;
            break;
          }

          case "message.updated": {
            const info = props.info as Message;
            if (!info || info.role !== "assistant") break;
            if (info.sessionID !== sessionId) break;
            if (handledMessages.has(info.id) && info.time?.completed) break;

            const { data } = await opencode.session.message({
              path: { id: sessionId, messageID: info.id },
              ...sessionQuery,
            }).catch(() => ({ data: undefined }));

            const parts = data?.parts ?? [];
            const text = extractTextFromParts(parts);
            if (text && text !== state.text) {
              state.phase = "responding";
              state.text = text;
              state.statusNote = null;
              await update(true);
            }

            if (!state.modelLabel) {
              state.modelLabel = `${info.providerID}/${info.modelID}`;
            }

            if (!sawStepFinish && info.tokens) {
              state.tokens.input += info.tokens.input;
              state.tokens.output += info.tokens.output;
              state.cost += info.cost ?? 0;
              recordUsage(userId, state.modelLabel, info.tokens.input + info.tokens.output, info.cost ?? 0);
            }

            if (info.time?.completed) {
              handledMessages.add(info.id);
            }
            break;
          }

          case "message.part.updated": {
            const part = props.part as { type: string; sessionID?: string };
            if (part.sessionID !== sessionId) break;

            if (part.type === "reasoning") {
              const r = part as ReasoningPart;
              state.phase = "reasoning";
              state.reasoning = r.text;
              await update();
            } else if (part.type === "tool") {
              const t = part as ToolPart;
              state.phase = "tools";
              state.tools.set(t.callID, {
                name: t.tool,
                title: t.state.status === "running" || t.state.status === "completed"
                  ? (t.state as { title?: string }).title || t.tool
                  : t.tool,
                status: t.state.status,
              });
              if (t.state.status === "running") {
                state.currentTool = t.tool;
              } else {
                state.toolHistory.push(t.tool);
                state.currentTool = null;
              }
              await update();
            } else if (part.type === "text") {
              const t = part as TextPart;
              if (t.text && t.text !== state.userInput) {
                state.phase = "responding";
                state.text = t.text;
                state.statusNote = null;
                await update();
              }
            } else if (part.type === "step-finish") {
              const s = part as StepFinishPart;
              sawStepFinish = true;
              state.tokens.input += s.tokens.input;
              state.tokens.output += s.tokens.output;
              state.cost += s.cost;
              recordUsage(userId, state.modelLabel, s.tokens.input + s.tokens.output, s.cost);
            }
            break;
          }

          case "todo.updated": {
            const todos = (props.todos as Todo[] | undefined) ?? [];
            state.todos = todos;
            await update();
            break;
          }

          case "file.edited": {
            const file = props.file as string;
            if (file && !state.filesEdited.includes(file)) {
              state.filesEdited.push(file);
            }
            break;
          }

          case "session.status": {
            const status = props as { type?: string; attempt?: number };
            if (status.type === "retry") {
              state.statusNote = `⏳ Retry ${status.attempt ?? ""}`.trim();
              await update();
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

    await pollPromise.catch(() => {});

    const final = state.aborted ? "⏹ Stopped." : renderFinalMessage(state);
    const rawChunks = splitRawMarkdown(final);
    const chunks = usePlainText ? rawChunks : rawChunks.map(chunk => toTelegramMarkdown(chunk));
    const parseMode = usePlainText ? undefined : TELEGRAM_PARSE_MODE;

    if (chunks.length > 1) {
      await editMessageWithRetry({
        api,
        chatId,
        messageId,
        text: chunks[0],
        replyMarkup: idleKeyboard(),
        parseMode,
      });
      for (const chunk of chunks.slice(1)) {
        await sleep(500);
        await sendMessageWithRetry({ api, chatId, text: chunk, messageThreadId, parseMode });
      }
    } else {
      await editMessageWithRetry({
        api,
        chatId,
        messageId,
        text: chunks[0] || (usePlainText ? "Done." : toTelegramMarkdown("Done.")),
        replyMarkup: idleKeyboard(),
        parseMode,
      });
    }
    await maybeUpdateStatusPanel({
      opencode,
      api,
      userId,
      chatId,
      contextKey,
      messageThreadId,
      forceBranchRefresh: true,
    });
  } catch (err) {
    console.error("Stream error:", err);
    await api.editMessageText(chatId, messageId, "Error processing message.", { reply_markup: idleKeyboard() }).catch(() => {});
  } finally {
    typing = false;
    activeMessages.delete(key);
  }
}

const { bot, opencode, server } = await initializeBot();

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
  void opencode.session.abort({
    path: { id: entry.sessionId },
    ...withSessionDirectory(entry.sessionId),
  }).catch(() => {});

  await ctx.editMessageText("⏹ Stopped.", { reply_markup: idleKeyboard() }).catch(() => {});
});

// Callback: Menu button
bot.callbackQuery("menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  const msg = ctx.callbackQuery?.message;
  if (!userId || !msg) return;
  const messageThreadId = getMessageThreadId(ctx);
  const contextKey = getSessionKey(msg.chat, messageThreadId);
  await closeMenusForUser({ api: ctx.api, userId });
  await openMenu({
    api: ctx.api,
    opencode,
    chatId: msg.chat.id,
    userId,
    contextKey,
    messageThreadId,
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
  const msg = ctx.callbackQuery?.message;
  if (!msg) {
    await ctx.answerCallbackQuery();
    return;
  }
  const { key, chatId, messageId } = menuMsg;
  const messageThreadId = getMessageThreadId(ctx);
  const contextKey = getSessionKey(msg.chat, messageThreadId);

  if (action === "close") {
    await ctx.answerCallbackQuery({ text: "Closed" });
    menuStates.delete(key);
    await closeMenuMessage(ctx.api, chatId, messageId);
    return;
  }

  if (action === "model") {
    await ctx.answerCallbackQuery();
    menuStates.delete(key);
    await closeMenuMessage(ctx.api, chatId, messageId);
    await openModelMenu({
      api: ctx.api,
      opencode,
      chatId,
      userId,
      messageThreadId,
    });
    return;
  }

  if (action === "mode") {
    await ctx.answerCallbackQuery();
    menuStates.delete(key);
    await closeMenuMessage(ctx.api, chatId, messageId);
    await openModeMenu({
      api: ctx.api,
      chatId,
      userId,
      messageThreadId,
    });
    return;
  }

  if (action === "status") {
    await ctx.answerCallbackQuery({ text: "Refreshing status..." });
    await updateStatusPanel({
      opencode,
      api: ctx.api,
      userId,
      chatId,
      contextKey,
      messageThreadId,
      force: true,
    });
    return;
  }

  if (action === "auth") {
    await ctx.answerCallbackQuery();
    menuStates.delete(key);
    await closeMenuMessage(ctx.api, chatId, messageId);
    await sendAuthMenu({
      api: ctx.api,
      opencode,
      chatId,
      messageThreadId,
    });
    return;
  }

  if (action === "git") {
    await ctx.answerCallbackQuery();
    await sendGitUsage({ api: ctx.api, chatId, messageThreadId });
    return;
  }

  if (action === "diff") {
    await ctx.answerCallbackQuery();
    await sendSessionDiff({
      api: ctx.api,
      opencode,
      chatId,
      contextKey,
      messageThreadId,
    });
    return;
  }

  if (action === "compact") {
    await ctx.answerCallbackQuery();
    await compactSession({
      api: ctx.api,
      opencode,
      chatId,
      contextKey,
      messageThreadId,
    });
    return;
  }

  if (action === "cost") {
    await ctx.answerCallbackQuery();
    await sendCostSummary({
      api: ctx.api,
      userId,
      chatId,
      messageThreadId,
    });
    return;
  }

  if (action === "back") {
    await ctx.answerCallbackQuery();
    const currentSessionId = chatSessions.get(contextKey);
    const currentTitle = await getCurrentSessionTitle(opencode, currentSessionId);
    const currentModel = formatModelLabel(getUserModel(userId));
    const currentMode = getUserAgentMode(userId);
    const currentDirectory = await getContextBaseDirectory({
      opencode,
      contextKey,
      sessionId: currentSessionId,
      userId,
    });
    await updateMenuMessage({
      api: ctx.api,
      chatId,
      messageId,
      text: menuMainText(currentTitle, currentModel, currentMode, currentDirectory),
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
    const currentTitle = await getCurrentSessionTitle(opencode, chatSessions.get(contextKey));
    const menu = buildSessionsMenu({
      sessions,
      page: nextPage,
      currentSessionId: chatSessions.get(contextKey),
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
    const index = Number(action.split(":")[1]);
    const state = menuStates.get(key);
    if (!state || !Number.isInteger(index)) {
      await ctx.answerCallbackQuery({ text: "Menu expired. Use /menu." });
      return;
    }
    const sessionId = state.sessionIds[index];
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: "Session not found." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Switching..." });

    if (chatSessions.get(contextKey) !== sessionId) {
      chatSessions.set(contextKey, sessionId);
    }

    const title = await getCurrentSessionTitle(opencode, sessionId);
    await ctx.api.sendMessage(
      chatId,
      formatSessionDivider(`🧭 Switched to ${title ?? sessionId.slice(0, 8)}`),
      withThreadId({}, messageThreadId),
    );
    await maybeUpdateStatusPanel({
      opencode,
      api: ctx.api,
      userId,
      chatId,
      contextKey,
      messageThreadId,
    });

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
    const session = await createNewSessionForChat({
      opencode,
      contextKey,
      userId,
    });
    if (!session) {
      await ctx.api.sendMessage(
        chatId,
        "Failed to start a new conversation.",
        withThreadId({}, messageThreadId),
      );
      return;
    }
    await ctx.api.sendMessage(
      chatId,
      formatSessionDivider("✨ New conversation started."),
      withThreadId({}, messageThreadId),
    );
    const currentTitle = await getCurrentSessionTitle(opencode, session.id);
    const currentModel = formatModelLabel(getUserModel(userId));
    const currentMode = getUserAgentMode(userId);
    const currentDirectory = await getContextBaseDirectory({
      opencode,
      contextKey,
      sessionId: session.id,
      userId,
    });
    await updateMenuMessage({
      api: ctx.api,
      chatId,
      messageId,
      text: menuMainText(currentTitle, currentModel, currentMode, currentDirectory),
      keyboard: menuMainKeyboard(),
      state: { userId, page: 0, sessionIds: [] },
    });
    await maybeUpdateStatusPanel({
      opencode,
      api: ctx.api,
      userId,
      chatId,
      contextKey,
      messageThreadId,
    });
    return;
  }

  if (action === "clear") {
    await ctx.answerCallbackQuery({ text: "Confirm clear" });
    const currentSessionId = chatSessions.get(contextKey);
    const currentTitle = await getCurrentSessionTitle(opencode, currentSessionId);
    const updated = await updateMenuMessage({
      api: ctx.api,
      chatId,
      messageId,
      text: menuClearText(currentTitle),
      keyboard: menuClearKeyboard(),
      state: { userId, page: 0, sessionIds: [] },
    });
    if (!updated) {
      menuStates.delete(key);
      await sendMenuMessage({
        api: ctx.api,
        chatId,
        text: menuClearText(currentTitle),
        keyboard: menuClearKeyboard(),
        state: { userId, page: 0, sessionIds: [] },
        messageThreadId,
      });
    }

    return;
  }

  if (action === "clear:confirm") {
    await ctx.answerCallbackQuery({ text: "Clearing..." });
    const currentId = chatSessions.get(contextKey);
    if (currentId) {
      await abortActiveStreamsForSession({ sessionId: currentId, opencode, api: ctx.api });
      await opencode.session.delete({
        path: { id: currentId },
        ...withSessionDirectory(currentId),
      }).catch(() => {});
      sessionTitleCache.delete(currentId);
    }
    const session = await createNewSessionForChat({
      opencode,
      contextKey,
      userId,
    });
    if (!session) {
      await ctx.api.sendMessage(
        chatId,
        "Failed to clear conversation.",
        withThreadId({}, messageThreadId),
      );
      return;
    }
    await ctx.api.sendMessage(
      chatId,
      formatSessionDivider("🧹 Cleared. New conversation started."),
      withThreadId({}, messageThreadId),
    );
    const currentTitle = await getCurrentSessionTitle(opencode, session.id);
    const currentModel = formatModelLabel(getUserModel(userId));
    const currentMode = getUserAgentMode(userId);
    const currentDirectory = await getContextBaseDirectory({
      opencode,
      contextKey,
      sessionId: session.id,
      userId,
    });
    await updateMenuMessage({
      api: ctx.api,
      chatId,
      messageId,
      text: menuMainText(currentTitle, currentModel, currentMode, currentDirectory),
      keyboard: menuMainKeyboard(),
      state: { userId, page: 0, sessionIds: [] },
    });
    await maybeUpdateStatusPanel({
      opencode,
      api: ctx.api,
      userId,
      chatId,
      contextKey,
      messageThreadId,
    });
    return;
  }

  if (action === "cd") {
    await ctx.answerCallbackQuery();
    menuStates.delete(key);
    await closeMenuMessage(ctx.api, chatId, messageId);
    const sessionId = chatSessions.get(contextKey) ?? null;
    const baseDir = await getContextBaseDirectory({
      opencode,
      contextKey,
      sessionId,
      userId,
    });
    const { text, keyboard } = await renderDirectoryBrowser({ contextKey, baseDir });
    await ctx.api.sendMessage(chatId, text, withThreadId({ reply_markup: keyboard }, messageThreadId));
    return;
  }
});

// Callback: Directory browser
  bot.callbackQuery(/^cd:(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    const userId = ctx.from?.id;
    const msg = ctx.callbackQuery?.message;
    if (!userId || !msg) {
      await ctx.answerCallbackQuery();
      return;
    }
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(msg.chat, messageThreadId);
    const sessionId = chatSessions.get(contextKey) ?? null;
    const currentState = directoryBrowseStates.get(contextKey);
    const baseDir = currentState?.baseDir ?? await getContextBaseDirectory({
      opencode,
      contextKey,
      sessionId,
      userId,
    });
    const page = currentState?.page ?? 0;

    const [command, param] = action.split(":");

    const render = async (dir: string, nextPage = 0, notice?: string) => {
      const { text, keyboard } = await renderDirectoryBrowser({
        contextKey,
        baseDir: dir,
        page: nextPage,
        notice,
      });
      await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => {});
    };

    if (command === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    if (command === "close") {
      directoryBrowseStates.delete(contextKey);
      await ctx.editMessageReplyMarkup({ reply_markup: EMPTY_INLINE_KEYBOARD }).catch(() => {});
      await ctx.answerCallbackQuery({ text: "Closed" });
      return;
    }

    if (command === "up") {
      const parent = path.dirname(baseDir);
      await render(parent, 0);
      await ctx.answerCallbackQuery();
      return;
    }

    if (command === "home") {
      const home = process.env.HOME ?? baseDir;
      await render(home, 0);
      await ctx.answerCallbackQuery();
      return;
    }

    if (command === "page") {
      const nextPage = Number(param ?? "0");
      if (!Number.isFinite(nextPage)) {
        await ctx.answerCallbackQuery({ text: "Invalid page" });
        return;
      }
      await render(baseDir, nextPage);
      await ctx.answerCallbackQuery();
      return;
    }

    if (command === "nav") {
      const index = Number(param ?? "-1");
      if (!currentState || !Number.isInteger(index)) {
        await ctx.answerCallbackQuery({ text: "No directory list" });
        return;
      }
      const entry = currentState.entries[index];
      if (!entry) {
        await ctx.answerCallbackQuery({ text: "Invalid selection" });
        return;
      }
      await render(entry.path, 0);
      await ctx.answerCallbackQuery();
      return;
    }

    if (command === "recent") {
      const index = Number(param ?? "-1");
      if (!currentState || !Number.isInteger(index)) {
        await ctx.answerCallbackQuery({ text: "No recents" });
        return;
      }
      const entry = currentState.recents[index];
      if (!entry) {
        await ctx.answerCallbackQuery({ text: "Invalid selection" });
        return;
      }
      await render(entry, 0);
      await ctx.answerCallbackQuery();
      return;
    }

    if (command === "reset") {
      setContextDirectory(contextKey, null);
      setUserDefaultDirectory(userId, null);
      const nextBase = await getContextBaseDirectory({
        opencode,
        contextKey,
        sessionId,
        userId,
      });
      await render(nextBase, 0, "Directory reset to default.");
      await updateStatusPanel({
        opencode,
        api: ctx.api,
        userId,
        chatId: msg.chat.id,
        contextKey,
        messageThreadId,
        force: true,
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (command === "select") {
      setContextDirectory(contextKey, baseDir);
      setUserDefaultDirectory(userId, baseDir);
      trackRecentDirectory(contextKey, baseDir);

      // Create a new session in the selected directory
      const session = await createNewSessionForChat({ opencode, contextKey, userId });
      if (session) {
        directoryBrowseStates.delete(contextKey);
        await ctx.editMessageText(
          `✅ Directory set to ${baseDir}\n\n✨ New session started.`,
          { reply_markup: idleKeyboard() },
        ).catch(() => {});
        await ctx.api.sendMessage(
          msg.chat.id,
          formatSessionDivider(`📁 New session in ${baseDir}`),
          withThreadId({}, messageThreadId),
        );
        await updateStatusPanel({
          opencode,
          api: ctx.api,
          userId,
          chatId: msg.chat.id,
          contextKey,
          messageThreadId,
          force: true,
        });
        await ctx.answerCallbackQuery({ text: "Session started" });
      } else {
        await render(baseDir, page, "✅ Selected but failed to create session.");
        await ctx.answerCallbackQuery({ text: "Error creating session" });
      }
      return;
    }

    if (command === "setdefault") {
      // Set as default without starting a new session
      setUserDefaultDirectory(userId, baseDir);
      trackRecentDirectory(contextKey, baseDir);
      await render(baseDir, page, `⭐ Default set to ${formatShortPath(baseDir)}`);
      await updateStatusPanel({
        opencode,
        api: ctx.api,
        userId,
        chatId: msg.chat.id,
        contextKey,
        messageThreadId,
        force: true,
      });
      await ctx.answerCallbackQuery({ text: "Default directory set" });
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // Callback: Model menu actions
  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    const userId = ctx.from?.id;
    if (!userId) return;
    const menuMsg = getModelMessageFromCallback(ctx);
    if (!menuMsg) {
      await ctx.answerCallbackQuery();
      return;
    }
    const msg = ctx.callbackQuery?.message;
    if (!msg) {
      await ctx.answerCallbackQuery();
      return;
    }
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(msg.chat, messageThreadId);
    const { chatId, messageId, key } = menuMsg;

    if (action === "close") {
      await ctx.answerCallbackQuery({ text: "Closed" });
      modelMenuStates.delete(key);
      await closeModelMessage(ctx.api, chatId, messageId);
      return;
    }

    if (action === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    const state = modelMenuStates.get(key);
    if (!state) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();

    const currentModel = formatModelLabel(getUserModel(userId));

    if (action === "prev" || action === "next") {
      if (state.view === "providers") {
        const nextPage = action === "next" ? state.providerPage + 1 : state.providerPage - 1;
        const recentModels = getRecentModels(userId);
        const menu = buildProviderMenu({
          providers: state.providers,
          page: nextPage,
          currentModel,
          recentModels,
          defaults: state.defaults,
        });
        state.providerPage = menu.page;
        await updateModelMessage({
          api: ctx.api,
          chatId,
          messageId,
          text: menu.text,
          keyboard: menu.keyboard,
          state,
        });
        return;
      }

      const provider = state.providers.find(item => item.id === state.providerId);
      if (!provider) {
        state.view = "providers";
        const recentModels = getRecentModels(userId);
        const menu = buildProviderMenu({
          providers: state.providers,
          page: state.providerPage,
          currentModel,
          recentModels,
          defaults: state.defaults,
        });
        await updateModelMessage({
          api: ctx.api,
          chatId,
          messageId,
          text: menu.text,
          keyboard: menu.keyboard,
          state,
        });
        return;
      }

      const nextPage = action === "next" ? state.modelPage + 1 : state.modelPage - 1;
      const menu = buildModelsMenu({ provider, page: nextPage, currentModel });
      state.modelPage = menu.page;
      await updateModelMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menu.text,
        keyboard: menu.keyboard,
        state,
      });
      return;
    }

    if (action === "back") {
      state.view = "providers";
      state.providerId = undefined;
      state.modelPage = 0;
      const recentModels = getRecentModels(userId);
      const menu = buildProviderMenu({
        providers: state.providers,
        page: state.providerPage,
        currentModel,
        recentModels,
        defaults: state.defaults,
      });
      await updateModelMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menu.text,
        keyboard: menu.keyboard,
        state,
      });
      return;
    }

    if (action.startsWith("recent:")) {
      const index = Number(action.split(":")[1]);
      if (!Number.isInteger(index)) return;
      const recentModels = getRecentModels(userId);
      const recent = recentModels[index];
      if (!recent) return;
      const settings = getUserSettings(userId);
      settings.model = { providerID: recent.providerID, modelID: recent.modelID };
      trackRecentModel(userId, recent.providerID, recent.modelID);
      const updatedModel = formatModelLabel(settings.model);
      const updatedRecent = getRecentModels(userId);
      const menu = buildProviderMenu({
        providers: state.providers,
        page: state.providerPage,
        currentModel: updatedModel,
        recentModels: updatedRecent,
        defaults: state.defaults,
      });
      await updateModelMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menu.text,
        keyboard: menu.keyboard,
        state,
      });
      await ctx.api.sendMessage(
        chatId,
        `✅ Model set to ${recent.label}`,
        withThreadId({}, messageThreadId),
      );
      await maybeUpdateStatusPanel({
        opencode,
        api: ctx.api,
        userId,
        chatId,
        contextKey,
        messageThreadId,
      });
      return;
    }

    if (action.startsWith("provider:")) {
      const index = Number(action.split(":")[1]);
      if (!Number.isInteger(index)) return;
      const provider = state.providers[index];
      if (!provider) return;
      state.view = "models";
      state.providerId = provider.id;
      state.modelPage = 0;
      const menu = buildModelsMenu({ provider, page: 0, currentModel });
      await updateModelMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menu.text,
        keyboard: menu.keyboard,
        state,
      });
      return;
    }

    if (action.startsWith("choose:")) {
      const index = Number(action.split(":")[1]);
      if (!Number.isInteger(index)) return;
      const provider = state.providers.find(item => item.id === state.providerId);
      if (!provider) return;
      const modelIndex = state.modelPage * MODEL_PAGE_SIZE + index;
      const model = provider.models[modelIndex];
      if (!model) return;
      const settings = getUserSettings(userId);
      settings.model = { providerID: provider.id, modelID: model.id };
      const updatedModel = formatModelLabel(settings.model);
      const menu = buildModelsMenu({ provider, page: state.modelPage, currentModel: updatedModel });
      await updateModelMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: menu.text,
        keyboard: menu.keyboard,
        state,
      });
      await ctx.api.sendMessage(
        chatId,
        `✅ Model set to ${model.name}`,
        withThreadId({}, messageThreadId),
      );
      await maybeUpdateStatusPanel({
        opencode,
        api: ctx.api,
        userId,
        chatId,
        contextKey,
        messageThreadId,
      });
      return;
    }
  });

  // Callback: Mode menu actions
  bot.callbackQuery(/^mode:(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    const userId = ctx.from?.id;
    if (!userId) return;
    const menuMsg = getModeMessageFromCallback(ctx);
    if (!menuMsg) {
      await ctx.answerCallbackQuery();
      return;
    }
    const msg = ctx.callbackQuery?.message;
    if (!msg) {
      await ctx.answerCallbackQuery();
      return;
    }
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(msg.chat, messageThreadId);
    const { chatId, messageId, key } = menuMsg;

    if (action === "close") {
      await ctx.answerCallbackQuery({ text: "Closed" });
      modeMenuStates.delete(key);
      await closeModeMessage(ctx.api, chatId, messageId);
      return;
    }

    const mode = action === "plan" ? "plan" : action === "build" ? "build" : null;
    if (!mode) {
      await ctx.answerCallbackQuery();
      return;
    }

    setUserAgentMode(userId, mode);
    await ctx.answerCallbackQuery({ text: `Mode set: ${mode}` });
    await ctx.api.editMessageText(chatId, messageId, modeMenuText(mode), {
      reply_markup: modeMenuKeyboard(mode),
    }).catch(() => {});
    await maybeUpdateStatusPanel({
      opencode,
      api: ctx.api,
      userId,
      chatId,
      contextKey,
      messageThreadId,
    });
  });

  // Callback: Auth actions
  bot.callbackQuery(/^auth:(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    const userId = ctx.from?.id;
    const msg = ctx.callbackQuery?.message;
    if (!userId || !msg) return;
    const messageThreadId = getMessageThreadId(ctx);

    const parts = action.split(":");
    if (parts[0] === "close") {
      await ctx.answerCallbackQuery({ text: "Closed" });
      await ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      return;
    }

    if (parts[0] === "api") {
      const providerId = parts[1];
      const methodIndex = Number(parts[2] ?? "0");
      if (!providerId || Number.isNaN(methodIndex)) return;
      pendingApiAuth.set(userId, { providerId, methodIndex, type: "api" });
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(
        msg.chat.id,
        `Send your API key for ${providerId}. It will be deleted after saving.\nUse /auth cancel to abort.`,
        withThreadId({}, messageThreadId),
      );
      return;
    }

    if (parts[0] === "oauth" && parts[1] === "complete") {
      const providerId = parts[2];
      const methodIndex = Number(parts[3] ?? "0");
      if (!providerId || Number.isNaN(methodIndex)) return;
      await ctx.answerCallbackQuery();
      try {
        await opencode.provider.oauth.callback({
          path: { id: providerId },
          body: { method: methodIndex },
        });
        await ctx.api.sendMessage(
          msg.chat.id,
          `✅ OAuth connected for ${providerId}.`,
          withThreadId({}, messageThreadId),
        );
      } catch (err) {
        console.error("OAuth complete failed:", err);
        await ctx.api.sendMessage(
          msg.chat.id,
          "OAuth completion failed.",
          withThreadId({}, messageThreadId),
        );
      }
      return;
    }

    if (parts[0] === "oauth") {
      const providerId = parts[1];
      const methodIndex = Number(parts[2] ?? "0");
      if (!providerId || Number.isNaN(methodIndex)) return;
      await ctx.answerCallbackQuery();
      try {
        const { data } = await opencode.provider.oauth.authorize({
          path: { id: providerId },
          body: { method: methodIndex },
        });
        if (!data) {
          await ctx.api.sendMessage(
            msg.chat.id,
            "OAuth authorization failed.",
            withThreadId({}, messageThreadId),
          );
          return;
        }
        const header = data.instructions ? `${data.instructions}\n\n` : "";
        const text = `${header}Open this URL:\n${data.url}`;
        if (data.method === "code") {
          pendingOauthAuth.set(userId, { providerId, methodIndex, type: "oauth" });
          await ctx.api.sendMessage(
            msg.chat.id,
            `${text}\n\nThen send: /auth code <oauth_code>`,
            withThreadId({}, messageThreadId),
          );
        } else {
          await ctx.api.sendMessage(
            msg.chat.id,
            text,
            withThreadId(
              {
                reply_markup: new InlineKeyboard().text("✅ Complete", `auth:oauth:complete:${providerId}:${methodIndex}`),
              },
              messageThreadId,
            ),
          );
        }
      } catch (err) {
        console.error("OAuth authorize failed:", err);
        await ctx.api.sendMessage(
          msg.chat.id,
          "OAuth authorization failed.",
          withThreadId({}, messageThreadId),
        );
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // Callback: Git confirmations
  bot.callbackQuery(/^git:(confirm|cancel):(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    const id = ctx.match![2];
    const userId = ctx.from?.id;
    if (!userId) return;
    const messageThreadId = getMessageThreadId(ctx);
    const pending = pendingGitCommands.get(id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Request expired" });
      return;
    }
    if (pending.userId !== userId) {
      await ctx.answerCallbackQuery({ text: "Not your command" });
      return;
    }
    if (Date.now() - pending.createdAt > GIT_CONFIRM_TTL_MS) {
      pendingGitCommands.delete(id);
      await ctx.answerCallbackQuery({ text: "Request expired" });
      return;
    }

    pendingGitCommands.delete(id);

    if (action === "cancel") {
      await ctx.answerCallbackQuery({ text: "Canceled" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Running..." });
    const result = await runGitCommand(pending.args);
    const output = result.stdout || result.stderr || "(no output)";
    await ctx.reply(
      formatCodeBlockMarkdown(output),
      withThreadId({ parse_mode: TELEGRAM_PARSE_MODE }, messageThreadId),
    );
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

    const queued = takeQueuedNudges(entry.sessionId);
    if (queued) {
      await sendNudge({ opencode, sessionId: entry.sessionId, text: queued }).catch(() => {});
    }

    await ctx.editMessageReplyMarkup({ reply_markup: abortKeyboard() }).catch(() => {});
  });

  // Fallback: answer any other callbacks
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    if (
      data === "abort" ||
      data === "menu" ||
      data.startsWith("perm:") ||
      data.startsWith("menu:") ||
      data.startsWith("model:") ||
      data.startsWith("mode:") ||
      data.startsWith("auth:") ||
      data.startsWith("git:") ||
      data.startsWith("cd:")
    ) return;
    await ctx.answerCallbackQuery();
  });

  // /start - Simple welcome
  bot.command("start", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    const baseDir = await getContextBaseDirectory({
      opencode,
      contextKey,
      sessionId: chatSessions.get(contextKey) ?? null,
      userId: uid,
    });
    await ctx.reply(
      `OpenCode\n\n📁 ${baseDir}\n\nJust send a message to start.`,
      withThreadId({ reply_markup: idleKeyboard() }, messageThreadId),
    );
    await updateStatusPanel({
      opencode,
      api: ctx.api,
      userId: uid,
      chatId: ctx.chat.id,
      contextKey,
      messageThreadId,
      force: true,
    });
  });

  // /status - Persistent status panel
  bot.command("status", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    await updateStatusPanel({
      opencode,
      api: ctx.api,
      userId: uid,
      chatId: ctx.chat.id,
      contextKey,
      messageThreadId,
      force: true,
    });
  });

  // /cd - Change working directory for new sessions
  bot.command("cd", async (ctx) => {
    const uid = ctx.from?.id;
    const message = ctx.message;
    if (!uid || !message?.text) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    const args = parseCommandArgs(message.text).slice(1);
    const rawInput = args.join(" ").trim();
    const sessionId = chatSessions.get(contextKey) ?? null;

    if (!rawInput) {
      const baseDir = await getContextBaseDirectory({
        opencode,
        contextKey,
        sessionId,
        userId: uid,
      });
      const { text, keyboard } = await renderDirectoryBrowser({ contextKey, baseDir });
      await ctx.reply(text, withThreadId({ reply_markup: keyboard }, messageThreadId));
      return;
    }

    if (rawInput === "reset") {
      setContextDirectory(contextKey, null);
      setUserDefaultDirectory(uid, null);
      const baseDir = await getContextBaseDirectory({
        opencode,
        contextKey,
        sessionId,
        userId: uid,
      });
      const { text, keyboard } = await renderDirectoryBrowser({
        contextKey,
        baseDir,
        notice: "Directory reset to default.",
      });
      await ctx.reply(text, withThreadId({ reply_markup: keyboard }, messageThreadId));
      await updateStatusPanel({
        opencode,
        api: ctx.api,
        userId: uid,
        chatId: ctx.chat.id,
        contextKey,
        messageThreadId,
        force: true,
      });
      return;
    }

    let input = rawInput;
    if (/^\d+$/.test(rawInput)) {
      const state = directoryBrowseStates.get(contextKey);
      if (!state) {
        await ctx.reply(
          "No directory menu open. Use /cd to browse, or /cd <path>.",
          withThreadId({}, messageThreadId),
        );
        return;
      }
      const index = Number(rawInput);
      const entry = state.entries[index - 1];
      if (!entry) {
        await ctx.reply(
          `Invalid selection. Choose 1-${state.entries.length} or use /cd <path>.`,
          withThreadId({}, messageThreadId),
        );
        return;
      }
      input = entry.path;
    }

    const baseDir = await getContextBaseDirectory({
      opencode,
      contextKey,
      sessionId,
      userId: uid,
    });
    const { path: nextDir, error } = await validateDirectoryInput(input, baseDir);
    if (!nextDir) {
      await ctx.reply(error ?? "Invalid directory.", withThreadId({}, messageThreadId));
      return;
    }

    setContextDirectory(contextKey, nextDir);
    setUserDefaultDirectory(uid, nextDir);
    trackRecentDirectory(contextKey, nextDir);

    const { text, keyboard } = await renderDirectoryBrowser({
      contextKey,
      baseDir: nextDir,
      notice: "✅ Selected. New sessions will start here.",
    });
    await ctx.reply(text, withThreadId({ reply_markup: keyboard }, messageThreadId));
    await updateStatusPanel({
      opencode,
      api: ctx.api,
      userId: uid,
      chatId: ctx.chat.id,
      contextKey,
      messageThreadId,
      force: true,
    });
  });

  // /auth - Provider authentication
  bot.command("auth", async (ctx) => {
    const uid = ctx.from?.id;
    const message = ctx.message;
    if (!uid || !message?.text) return;
    const messageThreadId = getMessageThreadId(ctx);
    const args = parseCommandArgs(message.text).slice(1);
    const action = args[0];

    if (action === "cancel") {
      pendingApiAuth.delete(uid);
      pendingOauthAuth.delete(uid);
      await ctx.reply("Auth flow canceled.", withThreadId({}, messageThreadId));
      return;
    }

    if (action === "status") {
      const { data } = await opencode.provider.list();
      const connected = data?.connected ?? [];
      if (connected.length === 0) {
        await ctx.reply("No providers connected yet.", withThreadId({}, messageThreadId));
        return;
      }
      await ctx.reply(
        `Connected providers:\n${connected.map(id => `• ${id}`).join("\n")}`,
        withThreadId({}, messageThreadId),
      );
      return;
    }

    if (action === "code") {
      const code = args.slice(1).join(" ").trim();
      if (!code) {
        await ctx.reply("Usage: /auth code <oauth_code>", withThreadId({}, messageThreadId));
        return;
      }
      const pending = pendingOauthAuth.get(uid);
      if (!pending) {
        await ctx.reply("No OAuth flow in progress. Use /auth first.", withThreadId({}, messageThreadId));
        return;
      }
      pendingOauthAuth.delete(uid);
      try {
        await opencode.provider.oauth.callback({
          path: { id: pending.providerId },
          body: { method: pending.methodIndex, code },
        });
        await ctx.reply(`✅ OAuth connected for ${pending.providerId}.`, withThreadId({}, messageThreadId));
      } catch (err) {
        console.error("OAuth callback failed:", err);
        await ctx.reply("OAuth callback failed. Try again.", withThreadId({}, messageThreadId));
      }
      return;
    }

    await sendAuthMenu({
      api: ctx.api,
      opencode,
      chatId: ctx.chat.id,
      messageThreadId,
    });
  });

  // /new - New conversation
  bot.command("new", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    const currentId = chatSessions.get(contextKey);
    if (currentId) {
      await abortActiveStreamsForSession({ sessionId: currentId, opencode, api: ctx.api });
    }
    const session = await createNewSessionForChat({ opencode, contextKey, userId: uid });
    if (!session) {
      await ctx.reply("Failed to create new conversation.", withThreadId({}, messageThreadId));
      return;
    }
    await ctx.reply(formatSessionDivider("✨ New conversation started."), withThreadId({}, messageThreadId));
    await maybeUpdateStatusPanel({
      opencode,
      api: ctx.api,
      userId: uid,
      chatId: ctx.chat.id,
      contextKey,
      messageThreadId,
    });
  });

  // /model - Model selection
  bot.command("model", async (ctx) => {
    const uid = ctx.from?.id;
    const message = ctx.message;
    if (!uid || !message) return;
    const messageThreadId = getMessageThreadId(ctx);
    await closeMenusForUser({ api: ctx.api, userId: uid });
    await openModelMenu({
      api: ctx.api,
      opencode,
      chatId: ctx.chat.id,
      userId: uid,
      messageThreadId,
      replyToMessageId: message.message_id,
    });
  });

  // /menu - Show main menu
  bot.command("menu", async (ctx) => {
    const uid = ctx.from?.id;
    const message = ctx.message;
    if (!uid || !message) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    await closeMenusForUser({ api: ctx.api, userId: uid });
    await openMenu({
      api: ctx.api,
      opencode,
      chatId: ctx.chat.id,
      userId: uid,
      contextKey,
      messageThreadId,
      replyToMessageId: message.message_id,
    });
  });

  // /git - Safe git commands
  bot.command("git", async (ctx) => {
    const uid = ctx.from?.id;
    const message = ctx.message;
    if (!uid || !message?.text) return;
    const messageThreadId = getMessageThreadId(ctx);
    const args = parseCommandArgs(message.text).slice(1);
    if (args.length === 0) {
      await ctx.reply(GIT_USAGE_TEXT, withThreadId({}, messageThreadId));
      return;
    }
    const subcommand = args[0];

    if (subcommand === "changes") {
      const [statusRes, diffRes, diffCachedRes] = await Promise.all([
        runGitCommand(["status", "--porcelain", "-b"]),
        runGitCommand(["diff", "--stat"]),
        runGitCommand(["diff", "--stat", "--cached"]),
      ]);
      if (statusRes.code !== 0) {
        const error = statusRes.stderr || statusRes.stdout || "git status failed";
        await ctx.reply(
          formatCodeBlockMarkdown(error),
          withThreadId({ parse_mode: TELEGRAM_PARSE_MODE }, messageThreadId),
        );
        return;
      }
      const text = formatGitChanges({
        status: statusRes.stdout,
        diffStat: diffRes.stdout,
        diffCachedStat: diffCachedRes.stdout,
      });
      await ctx.reply(
        formatCodeBlockMarkdown(text),
        withThreadId({ parse_mode: TELEGRAM_PARSE_MODE }, messageThreadId),
      );
      return;
    }

    if (!GIT_SAFE_COMMANDS.has(subcommand) && !GIT_CONFIRM_COMMANDS.has(subcommand)) {
      await ctx.reply(
        "Unsupported git command. Try /git status, /git log, or /git changes.",
        withThreadId({}, messageThreadId),
      );
      return;
    }

    if (GIT_SAFE_COMMANDS.has(subcommand)) {
      const result = await runGitCommand(args);
      const output = result.stdout || result.stderr || "(no output)";
      await ctx.reply(
        formatCodeBlockMarkdown(output),
        withThreadId({ parse_mode: TELEGRAM_PARSE_MODE }, messageThreadId),
      );
      return;
    }

    const id = crypto.randomUUID();
    pendingGitCommands.set(id, { userId: uid, args, createdAt: Date.now() });
    const warning = `⚠️ Run: git ${args.join(" ")}?`;
    await ctx.reply(
      warning,
      withThreadId(
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `git:confirm:${id}`)
            .text("❌ Cancel", `git:cancel:${id}`),
        },
        messageThreadId,
      ),
    );
  });

  // /diff - Session diff summary
  bot.command("diff", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    await sendSessionDiff({
      api: ctx.api,
      opencode,
      chatId: ctx.chat.id,
      contextKey,
      messageThreadId,
    });
  });

  // /compact - Summarize/compact session
  bot.command("compact", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    await compactSession({
      api: ctx.api,
      opencode,
      chatId: ctx.chat.id,
      contextKey,
      messageThreadId,
    });
  });

  // /cost - Usage stats
  bot.command("cost", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    await sendCostSummary({
      api: ctx.api,
      userId: uid,
      chatId: ctx.chat.id,
      messageThreadId,
    });
  });

  // /help - Show help message
  bot.command("help", async (ctx) => {
    const messageThreadId = getMessageThreadId(ctx);
    await ctx.reply(HELP_TEXT, withThreadId({}, messageThreadId));
  });

  // Inline queries
  bot.on("inline_query", async (ctx) => {
    const uid = ctx.from?.id;
    const query = ctx.inlineQuery.query.trim();
    if (!uid || !query) {
      await ctx.answerInlineQuery([], { cache_time: 1, is_personal: true });
      return;
    }

    const { data: session } = await opencode.session.create({
      body: { title: `inline:${uid}` },
    });
    if (!session?.id) {
      await ctx.answerInlineQuery([], { cache_time: 1, is_personal: true });
      return;
    }

    let responseText = "";
    try {
      const model = getUserModel(uid);
      const agent = getUserAgentMode(uid);
      const promptPromise = opencode.session.prompt({
        path: { id: session.id },
        body: {
          ...(model ? { model } : {}),
          agent,
          parts: buildTextParts(query),
        },
      });
      const result = await Promise.race([
        promptPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), INLINE_QUERY_TIMEOUT_MS)),
      ]) as Awaited<typeof promptPromise>;

      responseText = extractTextFromParts(result.data?.parts ?? []);
    } catch (err) {
      responseText = "⏳ Inline query timed out. Try again.";
    } finally {
      await opencode.session.delete({
        path: { id: session.id },
        ...withSessionDirectory(session.id),
      }).catch(() => {});
    }

    if (!responseText) responseText = "No response.";
    if (responseText.length > INLINE_QUERY_MAX_CHARS) {
      responseText = truncate(responseText, INLINE_QUERY_MAX_CHARS);
    }

    await ctx.answerInlineQuery([
      {
        type: "article",
        id: crypto.randomUUID(),
        title: "OpenCode response",
        input_message_content: {
          message_text: responseText,
        },
      },
    ], { cache_time: 1, is_personal: true });
  });

  // Photo attachments
  bot.on("message:photo", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    const photo = ctx.message.photo?.at(-1);
    if (!photo) return;
    if (photo.file_size && photo.file_size > MAX_ATTACHMENT_BYTES) {
      await ctx.reply("Image too large.", withThreadId({}, messageThreadId));
      return;
    }
    try {
      const buffer = await fetchTelegramFile(ctx.api, photo.file_id);
      const dataUrl = toDataUrl(buffer, "image/jpeg");
      const caption = ctx.message.caption?.trim() || "What is in this image?";
      await startStreamingReply({
        opencode,
        ctx,
        userId: uid,
        userText: caption,
        parts: [
          { type: "file", mime: "image/jpeg", url: dataUrl, filename: "photo.jpg" },
          { type: "text", text: caption },
        ],
        contextKey,
        messageThreadId,
        initialText: "🖼 Analyzing image...",
      });
    } catch (err) {
      console.error("Photo handling failed:", err);
      await ctx.reply("Failed to process image.", withThreadId({}, messageThreadId));
    }
  });

  // Image documents
  bot.on("message:document", async (ctx) => {
    const uid = ctx.from?.id;
    const doc = ctx.message.document;
    if (!uid || !doc?.mime_type?.startsWith("image/")) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    if (doc.file_size && doc.file_size > MAX_ATTACHMENT_BYTES) {
      await ctx.reply("Image too large.", withThreadId({}, messageThreadId));
      return;
    }
    try {
      const buffer = await fetchTelegramFile(ctx.api, doc.file_id);
      const dataUrl = toDataUrl(buffer, doc.mime_type);
      const caption = ctx.message.caption?.trim() || "What is in this image?";
      await startStreamingReply({
        opencode,
        ctx,
        userId: uid,
        userText: caption,
        parts: [
          { type: "file", mime: doc.mime_type, url: dataUrl, filename: doc.file_name ?? "image" },
          { type: "text", text: caption },
        ],
        contextKey,
        messageThreadId,
        initialText: "🖼 Analyzing image...",
      });
    } catch (err) {
      console.error("Document image handling failed:", err);
      await ctx.reply("Failed to process image.", withThreadId({}, messageThreadId));
    }
  });

  // Voice messages (bonus)
  bot.on("message:voice", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);
    const voice = ctx.message.voice;
    if (!voice) return;
    if (voice.file_size && voice.file_size > MAX_ATTACHMENT_BYTES) {
      await ctx.reply("Voice message too large.", withThreadId({}, messageThreadId));
      return;
    }
    if (!OPENAI_API_KEY) {
      await ctx.reply("Voice transcription requires OPENAI_API_KEY.", withThreadId({}, messageThreadId));
      return;
    }
    const status = await ctx.reply("🎤 Transcribing...", withThreadId({}, messageThreadId));
    try {
      const buffer = await fetchTelegramFile(ctx.api, voice.file_id);
      const transcript = await transcribeVoice(buffer);
      if (!transcript) {
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Transcription failed.").catch(() => {});
        return;
      }
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, `📝 Transcribed:\n${truncate(transcript, 200)}`).catch(() => {});
      await startStreamingReply({
        opencode,
        ctx,
        userId: uid,
        userText: transcript,
        parts: buildTextParts(transcript),
        contextKey,
        messageThreadId,
        initialText: "💭 Thinking...",
      });
    } catch (err) {
      console.error("Voice handling failed:", err);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Voice processing failed.").catch(() => {});
    }
  });

  // Message handler (skip commands)
  bot.on("message:text", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const messageThreadId = getMessageThreadId(ctx);
    const contextKey = getSessionKey(ctx.chat, messageThreadId);

    const pendingApi = pendingApiAuth.get(uid);
    if (pendingApi) {
      if (ctx.message.text.startsWith("/")) return;
      pendingApiAuth.delete(uid);
      const key = ctx.message.text.trim();
      if (!key) {
        await ctx.reply("API key cannot be empty.", withThreadId({}, messageThreadId));
        return;
      }
      await ctx.deleteMessage().catch(() => {});
      try {
        await opencode.auth.set({
          path: { id: pendingApi.providerId },
          body: { type: "api", key },
        });
        await ctx.reply(`✅ API key saved for ${pendingApi.providerId}.`, withThreadId({}, messageThreadId));
      } catch (err) {
        console.error("Auth set failed:", err);
        await ctx.reply("Failed to save API key.", withThreadId({}, messageThreadId));
      }
      return;
    }

    // Skip commands - they're handled by bot.command()
    if (ctx.message.text.startsWith("/")) return;

    const currentSessionId = chatSessions.get(contextKey);
    const activeEntry = getActiveEntryForSession(currentSessionId);
    if (activeEntry && !activeEntry.state.aborted) {
      const nudgeText = ctx.message.text.trim();
      if (!nudgeText) return;

      if (activeEntry.state.pendingPermission) {
        queueNudge(activeEntry.sessionId, nudgeText);
        return;
      }

      await sendNudge({ opencode, sessionId: activeEntry.sessionId, text: nudgeText })
        .catch((err) => {
          console.error("Nudge failed:", err);
        });
      return;
    }

    await startStreamingReply({
      opencode,
      ctx,
      userId: uid,
      userText: ctx.message.text,
      parts: buildTextParts(ctx.message.text),
      contextKey,
      messageThreadId,
    });
  });

  console.log("Starting Telegram bot...");
  bot.start();
  console.log("Bot running! Message your bot on Telegram.");
async function buildOpencodeConfig(): Promise<{ mcp?: McpConfigMap } | undefined> {
  const mcpConfig = parseJsonEnv<McpConfigMap>(OPENCODE_MCP_CONFIG);
  if (!mcpConfig) return undefined;
  return { mcp: mcpConfig };
}

async function initializeBot(): Promise<{ bot: Bot; opencode: OpencodeClient; server: { close(): void; url: string } }> {
  const cliCheck = checkOpenCodeCLI();
  if (!cliCheck.installed) {
    printOpenCodeNotFound();
    process.exit(1);
  }
  const version = cliCheck.version ?? "unknown";
  const binPath = cliCheck.path ?? "opencode";
  console.log(`OpenCode CLI: ${version} (${binPath})`);
  console.log(`Starting OpenCode server on port ${OPENCODE_PORT}...`);

  let opencode: OpencodeClient;
  let server: { close(): void; url: string };
  try {
    const config = await buildOpencodeConfig();
    const result = await createOpencode({
      port: OPENCODE_PORT,
      hostname: "127.0.0.1",
      ...(config ? { config } : {}),
    });
    opencode = result.client;
    server = result.server;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("EADDRINUSE") || message.includes("address already in use")) {
      printPortConflict(OPENCODE_PORT);
    } else {
      printServerError(err);
    }
    process.exit(1);
  }

  console.log(`OpenCode server ready at ${server.url}`);

  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  const cleanup = (reason: string) => {
    console.log(`Shutting down (${reason})...`);
    bot.stop();
    server.close();
  };
  process.once("SIGINT", () => { cleanup("SIGINT"); process.exit(0); });
  process.once("SIGTERM", () => { cleanup("SIGTERM"); process.exit(0); });
  process.once("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    cleanup("uncaughtException");
    process.exit(1);
  });
  process.once("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
    cleanup("unhandledRejection");
    process.exit(1);
  });

  bot.catch((err) => {
    const message = String(err);
    if (message.includes("query is too old") || message.includes("query ID is invalid")) {
      console.log("Ignored stale callback query");
      return;
    }
    if (message.includes("message is not modified")) {
      return;
    }
    console.error("Bot error:", err);
  });

  return { bot, opencode, server };
}

function checkOpenCodeCLI(): { installed: boolean; version?: string; path?: string } {
  const whichResult = Bun.spawnSync(["which", "opencode"]);
  if (whichResult.exitCode !== 0) {
    return { installed: false };
  }
  const binPath = whichResult.stdout.toString().trim();
  const versionResult = Bun.spawnSync(["opencode", "--version"]);
  const version = versionResult.exitCode === 0
    ? versionResult.stdout.toString().trim()
    : undefined;
  return { installed: true, version, path: binPath };
}

function printOpenCodeNotFound(): void {
  console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  OpenCode CLI not found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  This bot requires the OpenCode CLI to be installed.

  Install it with:

    curl -fsSL https://opencode.ai/install | bash

  Or visit: https://opencode.ai/docs/installation

  After installing, restart the bot.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

function printPortConflict(port: number): void {
  console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Port ${port} is already in use
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Another process (likely a previous OpenCode server) is
  already using port ${port}.

  Fix options:

  1. Find and kill the existing process:

     lsof -i :${port}
     kill <PID>

  2. Or use a different port:

     OPENCODE_PORT=${port + 1} bun run src/index.ts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

function printServerError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Failed to start OpenCode server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ${message}

  Check the OpenCode logs for more details:
    ~/.local/share/opencode/log/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

console.log("Starting Telegram bot...");
bot.start();
console.log("Bot running! Message your bot on Telegram.");
