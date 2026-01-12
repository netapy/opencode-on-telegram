import { Bot, InlineKeyboard, type Api } from "grammy"
import { autoRetry } from "@grammyjs/auto-retry"
import * as path from "node:path"
import { readdir, realpath, stat } from "node:fs/promises"
import {
  createOpencode,
  createOpencodeClient,
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
} from "@opencode-ai/sdk"

import type {
  UserSettings,
  DisplayState,
  ActiveMessage,
  MenuState,
  ModelMenuState,
  ModeMenuState,
  ProviderSummary,
  DirectoryBrowseState,
  ModelSelection,
  AgentMode,
  PermissionProfile,
  ScopeMode,
  HistoryEntry,
} from "./lib/types.js"

import * as db from "./lib/db.js"
import * as constants from "./lib/constants.js"
import * as utils from "./lib/utils.js"
import * as perms from "./lib/permissions.js"
import * as redact from "./lib/redact.js"
import * as safety from "./lib/safety.js"
import * as scopeLib from "./lib/scope.js"
import * as undoLib from "./lib/undo.js"
import * as exportLib from "./lib/export.js"
import * as workflows from "./lib/workflows.js"
import * as shell from "./lib/shell.js"

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ?.split(",").map(v => v.trim()).filter(Boolean).map(Number).filter(id => Number.isFinite(id) && id > 0) ?? []
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT) || 4097
const OPENCODE_MCP_CONFIG = process.env.OPENCODE_MCP_CONFIG
const OPENCODE_DEFAULT_DIR = process.env.OPENCODE_DEFAULT_DIR
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

if (!TELEGRAM_BOT_TOKEN) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1) }

type McpConfigMap = Record<string, McpLocalConfig | McpRemoteConfig>

const chatSessions = new Map<string, string>()
const activeMessages = new Map<string, ActiveMessage>()
const menuStates = new Map<string, MenuState>()
const modelMenuStates = new Map<string, ModelMenuState>()
const modeMenuStates = new Map<string, ModeMenuState>()
const sessionTitleCache = new Map<string, string>()
const sessionDirectoryCache = new Map<string, string>()
const contextDirectories = new Map<string, string>()
const directoryBrowseStates = new Map<string, DirectoryBrowseState>()
const userSettingsCache = new Map<number, UserSettings>()
const pendingApiAuth = new Map<number, { providerId: string; methodIndex: number; type: "api" }>()
const pendingOauthAuth = new Map<number, { providerId: string; methodIndex: number; type: "oauth" }>()
const pendingGitCommands = new Map<string, { userId: number; args: string[]; createdAt: number }>()
const pendingNudges = new Map<string, string[]>()
const historyBrowseStates = new Map<string, { sessionId: string; page: number; query?: string }>()
const workflowStates = new Map<string, { userId: number }>()

let cachedEnvDefaultDirectory: string | null | undefined
let warnedEnvDefaultDirectory = false

const EMPTY_INLINE_KEYBOARD = new InlineKeyboard()

function createDisplayState(userInput: string): DisplayState {
  return {
    phase: "thinking", userInput, reasoning: "", tools: new Map(), toolHistory: [],
    currentTool: null, text: "", statusNote: null, filesEdited: [], todos: [],
    tokens: { input: 0, output: 0 }, cost: 0, modelLabel: null, pendingPermission: null, aborted: false,
  }
}

function getUserSettings(userId: number): UserSettings {
  let settings = userSettingsCache.get(userId)
  if (!settings) {
    settings = db.loadUserSettings(userId) ?? {}
    userSettingsCache.set(userId, settings)
  }
  return settings
}

function saveUserSettings(userId: number, settings: UserSettings): void {
  userSettingsCache.set(userId, settings)
  db.saveUserSettings(userId, settings)
}

function getUserModel(userId: number): ModelSelection | null {
  const selected = getUserSettings(userId).model
  if (selected) return selected
  if (OPENAI_API_KEY) return { providerID: "openai", modelID: "gpt-5.2-chat-latest" }
  return null
}

function getUserAgentMode(userId: number): AgentMode {
  return getUserSettings(userId).agentMode ?? "build"
}

function getUserPermissionProfile(userId: number): PermissionProfile {
  return getUserSettings(userId).permissionProfile ?? "balanced"
}

function getUserScopeMode(userId: number): ScopeMode {
  return getUserSettings(userId).scopeMode ?? "user"
}

function getUserAllowedRoots(userId: number): string[] | undefined {
  return getUserSettings(userId).allowedRoots
}

function formatModelLabel(selection: ModelSelection | null | undefined): string | null {
  return selection ? `${selection.providerID}/${selection.modelID}` : null
}

function getMessageThreadId(ctx: { message?: { message_thread_id?: number }; callbackQuery?: { message?: { message_thread_id?: number } } }): number | undefined {
  const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id
  return typeof threadId === "number" && threadId > 0 ? threadId : undefined
}

function getSessionKey(chat: { id: number; type?: string }, userId: number, threadId?: number): string {
  const scopeMode = getUserScopeMode(userId)
  return scopeLib.buildScopeKey({ chatId: chat.id, chatType: chat.type ?? "private", threadId, userId, mode: scopeMode })
}

function withThreadId<T extends Record<string, unknown>>(options: T | undefined, messageThreadId?: number): T & { message_thread_id?: number } {
  if (!messageThreadId) return (options ?? {}) as T & { message_thread_id?: number }
  return { ...(options ?? {}), message_thread_id: messageThreadId } as T & { message_thread_id?: number }
}

function getSessionDirectoryHint(sessionId?: string | null): string | null {
  if (!sessionId) return null
  const cached = sessionDirectoryCache.get(sessionId)
  if (cached) return cached
  const loaded = db.loadSessionDirectory(sessionId)
  if (loaded) { sessionDirectoryCache.set(sessionId, loaded); return loaded }
  return null
}

function withSessionDirectory(sessionId?: string | null): { query: { directory: string } } | {} {
  const directory = getSessionDirectoryHint(sessionId)
  return directory ? { query: { directory } } : {}
}

async function getEnvDefaultDirectory(): Promise<string | null> {
  if (!OPENCODE_DEFAULT_DIR) return null
  if (cachedEnvDefaultDirectory !== undefined) return cachedEnvDefaultDirectory
  try {
    const resolved = path.resolve(OPENCODE_DEFAULT_DIR)
    const info = await stat(resolved).catch(() => null)
    if (info?.isDirectory()) { cachedEnvDefaultDirectory = resolved; return resolved }
  } catch {}
  if (!warnedEnvDefaultDirectory) { console.warn(`Invalid OPENCODE_DEFAULT_DIR: ${OPENCODE_DEFAULT_DIR}`); warnedEnvDefaultDirectory = true }
  cachedEnvDefaultDirectory = null
  return null
}

function getUserDefaultDirectory(userId: number): string | null {
  return getUserSettings(userId).defaultDirectory ?? null
}

function setUserDefaultDirectory(userId: number, dir: string | null): void {
  const settings = getUserSettings(userId)
  if (dir) settings.defaultDirectory = dir
  else delete settings.defaultDirectory
  saveUserSettings(userId, settings)
}

async function getNewSessionDirectory(contextKey: string, userId?: number): Promise<string> {
  const preferred = contextDirectories.get(contextKey)
  if (preferred) return preferred
  if (userId) { const userDef = getUserDefaultDirectory(userId); if (userDef) return userDef }
  const envDef = await getEnvDefaultDirectory()
  return envDef ?? utils.getHomeDirectory()
}

async function getCurrentSessionDirectory(opencode: OpencodeClient, sessionId?: string | null): Promise<string | null> {
  if (!sessionId) return null
  const cached = sessionDirectoryCache.get(sessionId)
  if (cached) return cached
  try {
    const { data } = await opencode.session.get({ path: { id: sessionId }, ...withSessionDirectory(sessionId) })
    if (data?.directory) {
      sessionDirectoryCache.set(sessionId, data.directory)
      db.saveSessionDirectory(sessionId, data.directory)
      return data.directory
    }
  } catch {}
  return null
}

async function getContextBaseDirectory(opencode: OpencodeClient, contextKey: string, sessionId?: string | null, userId?: number): Promise<string> {
  const preferred = contextDirectories.get(contextKey)
  if (preferred) return preferred
  if (sessionId) { const sessionDir = await getCurrentSessionDirectory(opencode, sessionId); if (sessionDir) return sessionDir }
  if (userId) { const userDef = getUserDefaultDirectory(userId); if (userDef) return userDef }
  const envDef = await getEnvDefaultDirectory()
  return envDef ?? utils.getHomeDirectory()
}

async function getCurrentSessionTitle(opencode: OpencodeClient, sessionId?: string): Promise<string | null> {
  if (!sessionId) return null
  const cached = sessionTitleCache.get(sessionId)
  if (cached) return utils.cleanSessionTitle(cached)
  const loaded = db.loadSessionTitle(sessionId)
  if (loaded) { sessionTitleCache.set(sessionId, loaded); return utils.cleanSessionTitle(loaded) }
  try {
    const { data } = await opencode.session.get({ path: { id: sessionId }, ...withSessionDirectory(sessionId) })
    if (data?.title) { sessionTitleCache.set(sessionId, data.title); db.saveSessionTitle(sessionId, data.title); return utils.cleanSessionTitle(data.title) }
  } catch {}
  return sessionId.slice(0, 8)
}

async function createNewSessionForChat(opencode: OpencodeClient, contextKey: string, userId?: number): Promise<Session | null> {
  const directory = await getNewSessionDirectory(contextKey, userId)
  try {
    const { data } = await opencode.session.create({ body: {}, query: { directory } })
    if (!data?.id) return null
    chatSessions.set(contextKey, data.id)
    db.saveChatSession(contextKey, data.id)
    if (data.directory) { sessionDirectoryCache.set(data.id, data.directory); db.saveSessionDirectory(data.id, data.directory) }
    return data
  } catch (err) { console.error("Session create failed:", err); return null }
}

async function ensureSessionId(opencode: OpencodeClient, contextKey: string, userId?: number): Promise<string | null> {
  let sessionId = chatSessions.get(contextKey)
  if (!sessionId) { sessionId = db.loadChatSession(contextKey) ?? undefined; if (sessionId) chatSessions.set(contextKey, sessionId) }
  if (!sessionId) { const session = await createNewSessionForChat(opencode, contextKey, userId); sessionId = session?.id }
  return sessionId ?? null
}

function recordUsage(userId: number, modelLabel: string | null, tokens: number, cost: number): void {
  const dateKey = utils.getDateKey()
  db.recordUsage(userId, modelLabel, dateKey, tokens, cost, 1)
}

function trackRecentModel(userId: number, providerID: string, modelID: string): void {
  db.saveRecentModel(userId, providerID, modelID, `${providerID}/${modelID}`)
}

function trackRecentDirectory(contextKey: string, dir: string): void {
  db.saveRecentDirectory(contextKey, dir)
}

function normalizeDisplayText(text: string | null | undefined): string {
  return (text ?? "").trim()
}

function extractTextFromParts(parts: Part[], userInput?: string): string {
  const chunks: string[] = []
  const normalizedInput = normalizeDisplayText(userInput)
  for (const part of parts) {
    if (part.type === "text") {
      const textPart = part as TextPart
      if (textPart.ignored) continue
      const normalized = normalizeDisplayText(textPart.text)
      if (!normalized) continue
      const isEcho = normalizedInput.length > 0 && normalized === normalizedInput
      if (textPart.synthetic === true || !isEcho) chunks.push(normalized)
      continue
    }
    if (part.type === "snapshot") {
      const snapshot = (part as { snapshot?: string }).snapshot
      const normalized = normalizeDisplayText(snapshot)
      if (normalized) chunks.push(normalized)
      continue
    }
    if (part.type === "step-start") {
      const snapshot = (part as { snapshot?: string }).snapshot
      const normalized = normalizeDisplayText(snapshot)
      if (normalized) chunks.push(normalized)
      continue
    }
    if (part.type === "step-finish") {
      const snapshot = (part as { snapshot?: string }).snapshot
      const normalized = normalizeDisplayText(snapshot)
      if (normalized) chunks.push(normalized)
      continue
    }
    if (part.type === "tool") {
      const state = (part as ToolPart).state as { status: string; output?: string }
      const output = normalizeDisplayText(state.output)
      if (state.status === "completed" && output) chunks.push(output)
    }
  }
  return chunks.join("\n").trim()
}

function mergeAssistantText(current: string, next: string): string {
  const normalizedNext = normalizeDisplayText(next)
  if (!normalizedNext) return current
  if (!current) return normalizedNext
  if (normalizedNext.startsWith(current)) return normalizedNext
  if (current.startsWith(normalizedNext)) return current
  return `${current}${current.endsWith("\n") ? "" : "\n"}${normalizedNext}`
}

function formatMessageError(error: unknown): string {
  const e = error as { message?: string; type?: string; code?: string }
  return e?.message ?? e?.type ?? e?.code ?? "Unknown error"
}

function hasToolUsage(parts: Part[]): string | null {
  const toolPart = parts.find(p => p.type === "tool") as ToolPart | undefined
  return toolPart ? (constants.TOOL_ICONS[toolPart.tool] ?? "🔧") : null
}

async function listSubdirectories(baseDir: string): Promise<string[]> {
  const listing = await readdir(baseDir, { withFileTypes: true })
  return listing.filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name).sort()
}

async function buildDirectoryBrowserState(contextKey: string, baseDir: string, page = 0): Promise<DirectoryBrowseState> {
  const normalizedBase = await realpath(baseDir).catch(() => baseDir)
  let subdirs: string[] = []; let error: string | null = null
  try { subdirs = await listSubdirectories(normalizedBase) } catch (err) { error = String(err) }
  const totalDirs = subdirs.length
  const totalPages = Math.max(1, Math.ceil(totalDirs / constants.MAX_DIR_ENTRIES))
  const safePage = Math.min(Math.max(page, 0), totalPages - 1)
  const start = safePage * constants.MAX_DIR_ENTRIES
  const pageDirs = subdirs.slice(start, start + constants.MAX_DIR_ENTRIES)
  const entries = pageDirs.map(name => ({ label: name, path: path.join(normalizedBase, name) }))
  const recents = db.loadRecentDirectories(contextKey).filter(d => d !== normalizedBase).slice(0, constants.MAX_RECENT_DIRS)
  const state: DirectoryBrowseState = { baseDir: normalizedBase, page: safePage, totalPages, totalDirs, entries, recents, error }
  directoryBrowseStates.set(contextKey, state)
  return state
}

function buildDirectoryBrowserText(state: DirectoryBrowseState, selectedDir: string | null, notice?: string): string {
  const lines = [`📁 ${state.baseDir}`]
  if (selectedDir) lines.push(`Selected: ${selectedDir}`)
  if (state.error) lines.push("", `Error: ${state.error}`)
  lines.push(state.totalPages > 1 ? `Page ${state.page + 1}/${state.totalPages} · ${state.totalDirs} folders` : `${state.totalDirs} folders`)
  if (notice) lines.push("", notice)
  lines.push("", "Tip: /cd <path> to jump")
  return lines.join("\n")
}

function buildDirectoryBrowserKeyboard(state: DirectoryBrowseState): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  const parent = path.dirname(state.baseDir)
  keyboard.text(parent !== state.baseDir ? "⬆️ .." : "⬆️ ..", parent !== state.baseDir ? "cd:up" : "cd:noop").text("🏠 ~", "cd:home").row()
  if (state.entries.length === 0) keyboard.text("(empty)", "cd:noop").row()
  else {
    state.entries.forEach((entry, i) => { keyboard.text(`📂 ${utils.truncate(entry.label, 18)}`, `cd:nav:${i}`); if ((i + 1) % 2 === 0) keyboard.row() })
    if (state.entries.length % 2 !== 0) keyboard.row()
  }
  if (state.totalPages > 1) {
    keyboard.text(state.page > 0 ? "◀" : "◀", state.page > 0 ? `cd:page:${state.page - 1}` : "cd:noop")
      .text(`${state.page + 1}/${state.totalPages}`, "cd:noop")
      .text(state.page < state.totalPages - 1 ? "▶" : "▶", state.page < state.totalPages - 1 ? `cd:page:${state.page + 1}` : "cd:noop").row()
  }
  state.recents.slice(0, 4).forEach((dir, i) => { keyboard.text(`⏱ ${utils.formatShortPath(dir, 18)}`, `cd:recent:${i}`); if ((i + 1) % 2 === 0) keyboard.row() })
  if (state.recents.length % 2 !== 0) keyboard.row()
  keyboard.text("✅ Select", "cd:select").text("⭐ Default", "cd:setdefault").row().text("🔄 Reset", "cd:reset").text("✖ Close", "cd:close")
  return keyboard
}

async function renderDirectoryBrowser(contextKey: string, baseDir: string, page = 0, notice?: string): Promise<{ text: string; keyboard: InlineKeyboard; state: DirectoryBrowseState }> {
  const state = await buildDirectoryBrowserState(contextKey, baseDir, page)
  const selectedDir = contextDirectories.get(contextKey) ?? null
  return { text: buildDirectoryBrowserText(state, selectedDir, notice), keyboard: buildDirectoryBrowserKeyboard(state), state }
}

function formatToolBreadcrumb(toolHistory: string[], currentTool: string | null): string {
  if (toolHistory.length === 0 && !currentTool) return ""
  const items: { name: string; count: number }[] = []
  for (const tool of toolHistory) { const last = items.at(-1); if (last?.name === tool) last.count++; else items.push({ name: tool, count: 1 }) }
  if (items.length > constants.MAX_BREADCRUMB_TOOLS) {
    const start = items.slice(0, Math.ceil(constants.MAX_BREADCRUMB_TOOLS / 2))
    const end = items.slice(-Math.floor(constants.MAX_BREADCRUMB_TOOLS / 2))
    items.length = 0; items.push(...start, { name: "…", count: 1 }, ...end)
  }
  const formatted = items.map((item, i) => {
    if (item.name === "…") return "…"
    const icon = constants.TOOL_ICONS[item.name] ?? "🔧"
    const showFull = i < constants.BREADCRUMB_FULL_NAME_COUNT
    const suffix = item.count > 2 ? ` x${item.count}` : ""
    return showFull ? `${icon} ${item.name}${suffix}` : `${icon}${suffix}`
  })
  let result = formatted.join(" → ")
  if (currentTool) {
    const icon = constants.TOOL_ICONS[currentTool] ?? "🔧"
    const last = items.at(-1)
    if (last?.name === currentTool) result += "..."
    else { if (result) result += " → "; result += items.length < constants.BREADCRUMB_FULL_NAME_COUNT ? `${icon} ${currentTool}...` : `${icon}...` }
  }
  return result
}

function formatTodoList(todos: Todo[]): string {
  if (todos.length === 0) return ""
  const lines = todos.slice(0, constants.MAX_TODO_ITEMS).map(t => `${constants.TODO_STATUS_ICONS[t.status] ?? "⬜"} ${t.content}`)
  const remaining = todos.length - lines.length
  if (remaining > 0) lines.push(`… +${remaining} more`)
  return ["📋 Tasks", ...lines].join("\n")
}

function formatPermissionRequest(permission: Permission): string {
  const icon = constants.PERMISSION_ICONS[permission.type] ?? "🔐"
  const lines = [`${icon} ${permission.title}`]
  const metadata = permission.metadata as Record<string, unknown>
  const cmd = metadata.command ?? metadata.cmd ?? metadata.input ?? metadata.text
  if (typeof cmd === "string" && cmd.length > 0) lines.push(`Command: ${utils.truncate(cmd, 300)}`)
  return lines.join("\n")
}

function renderDisplay(state: DisplayState, redactionEnabled: boolean): string {
  if (state.aborted) return "⏹ Stopped."
  if (state.phase === "permission" && state.pendingPermission) return formatPermissionRequest(state.pendingPermission)
  const breadcrumb = formatToolBreadcrumb(state.toolHistory, state.currentTool)
  let text = state.text
  if (redactionEnabled) text = redact.redactSecrets(text)
  text = normalizeDisplayText(text)
  if (text) return breadcrumb ? `${breadcrumb}\n\n${text}` : text
  const sections: string[] = []
  if (breadcrumb) sections.push(breadcrumb)
  const todoSection = formatTodoList(state.todos)
  if (todoSection) sections.push(todoSection)
  if (state.phase === "reasoning" && state.reasoning) sections.push(`🧠 ${utils.truncate(state.reasoning, 200)}`)
  else if (state.phase === "tools") sections.push([...state.tools.values()].map(t => `${constants.TOOL_ICONS[t.name] ?? "🔧"} ${t.title} ${t.status === "completed" ? "✓" : t.status === "error" ? "✗" : "…"}`).join("\n") || "⚙️ Working...")
  else sections.push("💭 Thinking...")
  if (state.statusNote) sections.push(state.statusNote)
  return sections.join("\n\n")
}

function renderFinalMessage(state: DisplayState, redactionEnabled: boolean): string {
  const sections: string[] = []
  const breadcrumb = formatToolBreadcrumb(state.toolHistory, null)
  if (breadcrumb) sections.push(breadcrumb, "")
  const todoSection = formatTodoList(state.todos)
  if (todoSection) sections.push(todoSection, "")
  let text = state.text
  if (redactionEnabled) text = redact.redactSecrets(text)
  const normalized = normalizeDisplayText(text)
  if (normalized) sections.push(text)
  else if (state.statusNote) sections.push(state.statusNote)
  else if (state.modelLabel) sections.push("(No response generated)")
  const footerParts: string[] = []
  if (state.modelLabel) footerParts.push(state.modelLabel)
  if (state.tokens.input + state.tokens.output > 0) footerParts.push(`${((state.tokens.input + state.tokens.output) / 1000).toFixed(1)}k`)
  if (state.cost > 0) footerParts.push(`$${state.cost.toFixed(3)}`)
  if (footerParts.length > 0) sections.push(`\n⟪ ${footerParts.join(" · ")} ⟫`)
  return sections.join("\n") || "Done."
}

function abortKeyboard(): InlineKeyboard { return new InlineKeyboard().text("⏹ Stop", "abort").text("☰ Menu", "menu") }
function idleKeyboard(): InlineKeyboard { return new InlineKeyboard().text("☰ Menu", "menu") }
function permissionKeyboard(): InlineKeyboard { return new InlineKeyboard().text("Allow", "perm:once").text("Always", "perm:always").text("Skip", "perm:reject").row().text("⏹ Stop", "abort").text("☰ Menu", "menu") }

async function editMessageWithRetry(api: Api, chatId: number, messageId: number, text: string, replyMarkup?: InlineKeyboard, parseMode?: "MarkdownV2"): Promise<boolean> {
  try { await api.editMessageText(chatId, messageId, text, { reply_markup: replyMarkup, ...(parseMode ? { parse_mode: parseMode } : {}) }); return true }
  catch (err) {
    const msg = String(err); const retry = utils.parseRetryAfterSeconds(msg)
    if (retry) { await utils.sleep((retry + 1) * 1000); try { await api.editMessageText(chatId, messageId, text, { reply_markup: replyMarkup, ...(parseMode ? { parse_mode: parseMode } : {}) }); return true } catch { return false } }
    if (parseMode && utils.isTelegramParseError(msg)) { try { await api.editMessageText(chatId, messageId, text, { reply_markup: replyMarkup }); return true } catch { return false } }
    if (!msg.includes("message is not modified")) console.error("Edit message failed:", msg)
    return false
  }
}

async function sendMessageWithRetry(api: Api, chatId: number, text: string, replyMarkup?: InlineKeyboard, messageThreadId?: number, parseMode?: "MarkdownV2"): Promise<void> {
  const options = withThreadId({ reply_markup: replyMarkup, ...(parseMode ? { parse_mode: parseMode } : {}) }, messageThreadId)
  try { await api.sendMessage(chatId, text, options) }
  catch (err) {
    const msg = String(err); const retry = utils.parseRetryAfterSeconds(msg)
    if (retry) { await utils.sleep((retry + 1) * 1000); await api.sendMessage(chatId, text, options); return }
    if (parseMode && utils.isTelegramParseError(msg)) { await api.sendMessage(chatId, text, withThreadId({ reply_markup: replyMarkup }, messageThreadId)); return }
    console.error("Send message failed:", err)
  }
}

async function streamSession(params: {
  opencode: OpencodeClient; api: Api; sessionId: string; chatId: number; messageId: number; userId: number;
  userText: string; parts: (TextPartInput | FilePartInput)[]; model: ModelSelection | null; agent: AgentMode;
  contextKey: string; messageThreadId?: number
}): Promise<void> {
  const { opencode, api, sessionId, chatId, messageId, userText, userId, parts, model, agent, contextKey, messageThreadId } = params
  const state = createDisplayState(userText)
  const modelLabel = formatModelLabel(model)
  state.modelLabel = modelLabel
  const permProfile = getUserPermissionProfile(userId)
  const redactionEnabled = getUserSettings(userId).secretRedaction !== false
  const allowedRoots = getUserAllowedRoots(userId)
  if (model) trackRecentModel(userId, model.providerID, model.modelID)
  const handledMessages = new Set<string>()
  let sawStepFinish = false, lastRender = "", lastUpdate = 0, nextEditAllowedAt = 0
  let lastKeyboardToken: "abort" | "permission" = "abort", usePlainText = false
  const key = utils.messageKey(chatId, messageId)
  const abortController = new AbortController()
  activeMessages.set(key, { userId, sessionId, state, abortController })
  let typing = true
  ;(async () => { while (typing) { await api.sendChatAction(chatId, "typing", withThreadId(undefined, messageThreadId)).catch(() => {}); await utils.sleep(4000) } })()

  const update = async (force = false) => {
    if (state.aborted) return
    const now = Date.now()
    const rendered = renderDisplay(state, redactionEnabled)
    const permActive = state.phase === "permission" && Boolean(state.pendingPermission)
    const desiredToken = permActive ? "permission" : "abort"
    const desiredKeyboard = permActive ? permissionKeyboard() : abortKeyboard()
    const keyboardChanged = desiredToken !== lastKeyboardToken
    if (now < nextEditAllowedAt) return
    const clamped = utils.clampRawMarkdown(rendered || "...")
    const formatted = usePlainText ? clamped.text : utils.toTelegramMarkdown(clamped.text)
    const contentChanged = formatted !== lastRender
    if (!force && !contentChanged && !keyboardChanged) return
    if (!force && now - lastUpdate < constants.UPDATE_INTERVAL_MS && !keyboardChanged) return
    try {
      await api.editMessageText(chatId, messageId, formatted, { reply_markup: desiredKeyboard, ...(usePlainText ? {} : { parse_mode: constants.TELEGRAM_PARSE_MODE }) })
      lastRender = formatted; lastUpdate = now; lastKeyboardToken = desiredToken
    } catch (err) {
      const msg = String(err); const retry = utils.parseRetryAfterSeconds(msg)
      if (retry) { nextEditAllowedAt = now + retry * 1000; return }
      if (!usePlainText && utils.isTelegramParseError(msg)) { usePlainText = true; try { await api.editMessageText(chatId, messageId, clamped.text, { reply_markup: desiredKeyboard }); lastRender = clamped.text; lastUpdate = now; lastKeyboardToken = desiredToken } catch {} }
    }
  }

  try {
    const sessionQuery = withSessionDirectory(sessionId)
    const events = await opencode.event.subscribe({ signal: abortController.signal, ...sessionQuery })
    let promptError: string | null = null
    const promptPromise = opencode.session.prompt({ path: { id: sessionId }, ...sessionQuery, body: { ...(model ? { model } : {}), ...(agent ? { agent } : {}), parts } })
      .then(r => r.data ?? null).catch(err => { promptError = String(err); return null })

    const pollPromise = (async () => {
      const promptData = await promptPromise
      if (state.aborted || !promptData) return
      const promptRecord = typeof promptData === "object" ? promptData as Record<string, unknown> : null
      const promptInfo = promptRecord?.info as Message | undefined
      const assistantInfo = promptInfo?.role === "assistant" ? promptInfo : null
      if (!assistantInfo?.id) { if (promptError) { state.phase = "responding"; state.text = `⚠️ Error: ${promptError}`; await update(true); abortController.abort() }; return }
      const messageId = assistantInfo.id
      let lastText = extractTextFromParts((promptRecord?.parts ?? []) as Part[], state.userInput)
      let stableCount = 0, delay = constants.POLL_INITIAL_MS, lastTextChange = Date.now()
      if (!state.modelLabel) state.modelLabel = `${assistantInfo.providerID}/${assistantInfo.modelID}`
      if (!sawStepFinish && assistantInfo.tokens) { state.tokens.input += assistantInfo.tokens.input; state.tokens.output += assistantInfo.tokens.output; state.cost += assistantInfo.cost ?? 0; recordUsage(userId, state.modelLabel, assistantInfo.tokens.input + assistantInfo.tokens.output, assistantInfo.cost ?? 0) }
      if (lastText) { state.phase = "responding"; state.text = lastText; await update(true) }
      while (!state.aborted) {
        const { data } = await opencode.session.message({ path: { id: sessionId, messageID: messageId }, ...sessionQuery }).catch(() => ({ data: undefined }))
        const info = data?.info as Message | undefined
        const parts = data?.parts ?? []
        const text = extractTextFromParts(parts, state.userInput)
        if (text && text !== lastText) { lastText = text; lastTextChange = Date.now(); stableCount = 0; state.phase = "responding"; state.text = mergeAssistantText(state.text, text); await update(true) } else stableCount++
        if (info?.role === "assistant") { if (!state.modelLabel) state.modelLabel = `${info.providerID}/${info.modelID}`; if (!sawStepFinish && info.tokens) { state.tokens.input += info.tokens.input; state.tokens.output += info.tokens.output; state.cost += info.cost ?? 0; recordUsage(userId, state.modelLabel, info.tokens.input + info.tokens.output, info.cost ?? 0) }; if (info.time?.completed) break }
        if (stableCount >= constants.STABLE_POLL_COUNT && Date.now() - lastTextChange > constants.MIN_STABLE_MS) break
        delay = Math.min(constants.POLL_MAX_MS, delay * 1.5); await utils.sleep(delay)
      }
    })()

    try {
      eventLoop: for await (const event of events.stream as AsyncIterable<Event>) {
        if (state.aborted) break
        if (!("properties" in event)) continue
        const props = event.properties as Record<string, unknown>
        const evtSession = (props.sessionID as string) ?? ((props.part as Record<string, unknown>)?.sessionID as string)
        if (evtSession && evtSession !== sessionId) continue

        switch (event.type) {
          case "permission.updated": {
            const perm = props as Permission
            if (perm.sessionID !== sessionId) break
            const safetyCheck = safety.checkPermissionSafety(perm, allowedRoots)
            if (!safetyCheck.allowed) {
              await opencode.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: perm.id }, ...sessionQuery, body: { response: "reject" } })
              state.statusNote = `⚠️ ${safetyCheck.reason}`; await update(true); break
            }
            if (perms.shouldAutoAllow(perm, permProfile, userId)) {
              await opencode.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: perm.id }, ...sessionQuery, body: { response: "once" } }); break
            }
            state.phase = "permission"; state.pendingPermission = perm; await update(true)
            await new Promise<void>(resolve => { const entry = activeMessages.get(key); if (!entry) return resolve(); entry.resolvePermission = resolve })
            if (state.aborted) break eventLoop
            break
          }
          case "message.updated": {
            const info = props.info as Message
            if (!info || info.role !== "assistant" || info.sessionID !== sessionId) break
            if (handledMessages.has(info.id) && info.time?.completed) break
            const { data } = await opencode.session.message({ path: { id: sessionId, messageID: info.id }, ...sessionQuery }).catch(() => ({ data: undefined }))
            const msgParts = data?.parts ?? []
            const text = extractTextFromParts(msgParts)
            if (text && text !== state.text) { state.phase = "responding"; state.text = mergeAssistantText(state.text, text); await update(true) }
            if (!state.modelLabel) state.modelLabel = `${info.providerID}/${info.modelID}`
            if (!sawStepFinish && info.tokens) { state.tokens.input += info.tokens.input; state.tokens.output += info.tokens.output; state.cost += info.cost ?? 0; recordUsage(userId, state.modelLabel, info.tokens.input + info.tokens.output, info.cost ?? 0) }
            if (info.time?.completed) handledMessages.add(info.id)
            break
          }
          case "message.part.updated": {
            const part = props.part as { type: string; sessionID?: string }
            const delta = props.delta as string | undefined
            if (part.sessionID !== sessionId) break
            if (part.type === "reasoning") { state.phase = "reasoning"; state.reasoning = (part as ReasoningPart).text; await update() }
            else if (part.type === "tool") {
              const t = part as ToolPart; state.phase = "tools"
              state.tools.set(t.callID, { name: t.tool, title: (t.state.status === "running" || t.state.status === "completed" ? (t.state as { title?: string }).title : t.tool) ?? t.tool, status: t.state.status })
              if (t.state.status === "running") state.currentTool = t.tool
              else { state.toolHistory.push(t.tool); state.currentTool = null }
              await update()
            } else if (part.type === "text") {
              const t = part as TextPart
              if (delta) {
                state.phase = "responding"
                state.text += delta
                await update()
              } else if (t.text && t.text.trim() && t.text !== state.userInput) {
                state.phase = "responding"
                state.text = mergeAssistantText(state.text, t.text)
                await update()
              }
            } else if (part.type === "step-finish") { const s = part as StepFinishPart; sawStepFinish = true; state.tokens.input += s.tokens.input; state.tokens.output += s.tokens.output; state.cost += s.cost; recordUsage(userId, state.modelLabel, s.tokens.input + s.tokens.output, s.cost) }
            break
          }
          case "todo.updated": { state.todos = (props.todos as Todo[] | undefined) ?? []; await update(); break }
          case "file.edited": { const file = props.file as string; if (file && !state.filesEdited.includes(file)) { state.filesEdited.push(file); await undoLib.createFileUndoEntry(userId, file, "edit") } break }
          case "session.status": { const status = props as { type?: string; attempt?: number }; if (status.type === "retry") { state.statusNote = `⏳ Retry ${status.attempt ?? ""}`.trim(); await update() } break }
          case "session.idle": break
        }
        if (event.type === "session.idle") break eventLoop
      }
    } catch (err) { if (!state.aborted && !abortController.signal.aborted) console.error("Event stream error:", err) }
    finally { abortController.abort() }
    await pollPromise.catch(() => {})
    const final = state.aborted ? "⏹ Stopped." : renderFinalMessage(state, redactionEnabled)
    const rawChunks = utils.splitRawMarkdown(final)
    const chunks = usePlainText ? rawChunks : rawChunks.map(c => utils.toTelegramMarkdown(c))
    const parseMode = usePlainText ? undefined : constants.TELEGRAM_PARSE_MODE
    if (chunks.length > 1) {
      await editMessageWithRetry(api, chatId, messageId, chunks[0], idleKeyboard(), parseMode)
      for (const chunk of chunks.slice(1)) { await utils.sleep(500); await sendMessageWithRetry(api, chatId, chunk, undefined, messageThreadId, parseMode) }
    } else await editMessageWithRetry(api, chatId, messageId, chunks[0] || (usePlainText ? "Done." : utils.toTelegramMarkdown("Done.")), idleKeyboard(), parseMode)
    db.saveHistoryEntry({ id: crypto.randomUUID(), sessionId, role: "user", timestamp: Date.now(), text: userText })
    db.saveHistoryEntry({ id: crypto.randomUUID(), sessionId, role: "assistant", timestamp: Date.now(), text: state.text, toolNames: state.toolHistory })
  } catch (err) { console.error("Stream error:", err); await api.editMessageText(chatId, messageId, "Error processing message.", { reply_markup: idleKeyboard() }).catch(() => {}) }
  finally { typing = false; activeMessages.delete(key) }
}

async function startStreamingReply(params: {
  opencode: OpencodeClient; ctx: { api: Api; chat: { id: number }; reply: (text: string, options?: { reply_markup?: InlineKeyboard; message_thread_id?: number }) => Promise<{ message_id: number }> };
  userId: number; userText: string; parts: (TextPartInput | FilePartInput)[]; contextKey: string; messageThreadId?: number; initialText?: string
}): Promise<void> {
  const { opencode, ctx, userId, userText, parts, contextKey, messageThreadId, initialText } = params
  const sessionId = await ensureSessionId(opencode, contextKey, userId)
  if (!sessionId) { await ctx.reply("Failed to create session.", withThreadId(undefined, messageThreadId)); return }
  const msg = await ctx.reply(initialText ?? "💭 Thinking...", withThreadId({ reply_markup: abortKeyboard() }, messageThreadId))
  await streamSession({ opencode, api: ctx.api, sessionId, chatId: ctx.chat.id, messageId: msg.message_id, userId, userText, parts, model: getUserModel(userId), agent: getUserAgentMode(userId), contextKey, messageThreadId })
}

async function fetchTelegramFile(api: Api, fileId: string): Promise<Buffer> {
  const file = await api.getFile(fileId); if (!file.file_path) throw new Error("File path missing")
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`
  const response = await fetch(url); if (!response.ok) throw new Error(`Failed (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}

function toDataUrl(buffer: Buffer, mime: string): string { return `data:${mime};base64,${buffer.toString("base64")}` }

async function transcribeVoice(buffer: Buffer): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured")
  const form = new FormData(); form.append("model", "whisper-1"); form.append("file", new Blob([buffer], { type: "audio/ogg" }), "voice.ogg")
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form })
  if (!response.ok) throw new Error(`Transcription failed (${response.status})`)
  return ((await response.json()) as { text?: string }).text?.trim() ?? ""
}

async function runGitCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
  return { code: await proc.exited, stdout: (await new Response(proc.stdout).text()).trim(), stderr: (await new Response(proc.stderr).text()).trim() }
}

async function listSessions(opencode: OpencodeClient, directory?: string): Promise<Session[]> {
  const { data } = await opencode.session.list({ query: directory ? { directory } : undefined })
  const sessions = data ?? []; sessions.sort((a, b) => b.time.updated - a.time.updated)
  sessions.forEach(s => { sessionTitleCache.set(s.id, s.title); if (s.directory) sessionDirectoryCache.set(s.id, s.directory) })
  return sessions
}

async function fetchProviders(opencode: OpencodeClient): Promise<{ providers: ProviderSummary[] }> {
  const { data } = await opencode.provider.list()
  const connectedIds = new Set(data?.connected ?? [])
  const providers = (data?.all ?? []).filter(p => connectedIds.has(p.id)).map(p => ({
    id: p.id, name: p.name, models: Object.values(p.models ?? {}).map(m => ({ id: m.id, name: m.name, attachment: m.attachment, reasoning: m.reasoning, tool_call: m.tool_call, status: m.status }))
  }))
  return { providers }
}

function menuMainText(title: string | null, model: string | null, mode: AgentMode, profile: PermissionProfile, scopeMode: ScopeMode, dir?: string): string {
  return `Menu\nSession: ${title ?? "None"}\nModel: ${model ?? "default"}\nMode: ${mode} | Profile: ${profile}\nScope: ${scopeMode}\nDir: ${dir ? utils.formatShortPath(dir) : "default"}`
}

function menuMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Status", "menu:status").text("🗂 Sessions", "menu:sessions").row()
    .text("✨ New", "menu:new").text("🧹 Clear", "menu:clear").row()
    .text("📁 Dir", "menu:cd").text("🤖 Model", "menu:model").row()
    .text("🧭 Mode", "menu:mode").text("🔐 Profile", "menu:profile").row()
    .text("👥 Scope", "menu:scope").text("🔑 Auth", "menu:auth").row()
    .text("📋 Workflow", "menu:workflow").text("🔄 Undo", "menu:undo").row()
    .text("📤 Export", "menu:export").text("📜 History", "menu:history").row()
    .text("🧾 Git", "menu:git").text("💸 Cost", "menu:cost").row()
    .text("✖ Close", "menu:close")
}

function workflowMenuKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  workflows.BUILTIN_WORKFLOWS.slice(0, 8).forEach((wf, i) => { kb.text(`${wf.icon} ${wf.name}`, `wf:${wf.id}`); if ((i + 1) % 2 === 0) kb.row() })
  if (workflows.BUILTIN_WORKFLOWS.length % 2 !== 0) kb.row()
  return kb.text("⬅ Back", "menu:back").text("✖ Close", "menu:close")
}

function undoMenuKeyboard(entries: { id: string; description: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  entries.slice(0, 5).forEach(e => { kb.text(`↩️ ${utils.truncate(e.description, 24)}`, `undo:${e.id}`).row() })
  return kb.text("⬅ Back", "menu:back").text("✖ Close", "menu:close")
}

function historyMenuKeyboard(hasMore: boolean, page: number): InlineKeyboard {
  const kb = new InlineKeyboard()
  if (page > 0) kb.text("◀ Prev", `hist:page:${page - 1}`)
  if (hasMore) kb.text("Next ▶", `hist:page:${page + 1}`)
  if (page > 0 || hasMore) kb.row()
  return kb.text("🔍 Search", "hist:search").row().text("⬅ Back", "menu:back").text("✖ Close", "menu:close")
}

function exportMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📝 Markdown", "exp:md").text("📊 JSON", "exp:json").row()
    .text("🌐 HTML", "exp:html").row()
    .text("⬅ Back", "menu:back").text("✖ Close", "menu:close")
}

interface SessionsMenuResult {
  text: string
  keyboard: InlineKeyboard
  sessionIds: string[]
}

async function buildSessionsMenu(
  opencode: OpencodeClient,
  dir: string,
  currentSessionId: string | undefined,
  page: number,
  showAll: boolean,
  includeBackButton: boolean
): Promise<SessionsMenuResult> {
  const sessions = await listSessions(opencode, showAll ? undefined : dir)
  const pageSize = 6
  const totalPages = Math.max(1, Math.ceil(sessions.length / pageSize))
  const safePage = Math.min(Math.max(page, 0), totalPages - 1)
  const pageSessions = sessions.slice(safePage * pageSize, (safePage + 1) * pageSize)

  const kb = new InlineKeyboard()
  pageSessions.forEach((s, i) => {
    const isCurrent = s.id === currentSessionId
    const folderHint = showAll && s.directory ? ` 📁${utils.formatShortPath(s.directory).slice(0, 12)}` : ""
    const label = `${isCurrent ? "• " : ""}${utils.cleanSessionTitle(s.title)} · ${utils.formatRelativeTime(s.time.updated)}${folderHint}`
    kb.text(utils.truncate(label, 42), `menu:switch:${i}`).row()
  })
  if (totalPages > 1) {
    if (safePage > 0) kb.text("◀ Prev", "menu:prev")
    if (safePage < totalPages - 1) kb.text("Next ▶", "menu:next")
    kb.row()
  }
  kb.text(showAll ? "📁 Folder" : "🌐 All", showAll ? "menu:folder" : "menu:all").text("✨ New", "menu:new").row()
  if (includeBackButton) kb.text("⬅ Back", "menu:back")
  kb.text("✖ Close", "menu:close")

  const header = showAll
    ? `🌐 All Sessions (${safePage + 1}/${totalPages})`
    : `📁 ${utils.formatShortPath(dir)} (${safePage + 1}/${totalPages})`

  return { text: header, keyboard: kb, sessionIds: pageSessions.map(s => s.id) }
}

function extractMessageText(parts: Part[]): string {
  const textPart = parts.find(p => p.type === "text") as TextPart | undefined
  if (textPart?.text && typeof textPart.text === "string" && textPart.text.trim()) return textPart.text.trim()
  const reasoningPart = parts.find(p => p.type === "reasoning") as ReasoningPart | undefined
  if (reasoningPart?.text && typeof reasoningPart.text === "string" && reasoningPart.text.trim()) return reasoningPart.text.trim()
  const toolPart = parts.find(p => p.type === "tool") as ToolPart | undefined
  if (toolPart?.tool) return `[${toolPart.tool}]`
  return ""
}

async function formatSessionContext(opencode: OpencodeClient, sessionId: string, title: string, directory?: string | null | undefined, recentCount = 4): Promise<string> {
  const lines = [`🧭 Switched to: ${title}`]
  if (directory) lines.push(`📁 ${utils.formatShortPath(directory)}`)
  try {
    const { data } = await opencode.session.messages({ path: { id: sessionId }, ...withSessionDirectory(sessionId) })
    const messages = (data ?? []).slice(-recentCount * 2)
    const displayMessages: { role: string; text: string }[] = []
    for (const msg of messages) {
      const text = extractMessageText(msg.parts)
      if (text) displayMessages.push({ role: msg.info.role, text })
    }
    if (displayMessages.length > 0) {
      lines.push("")
      for (const msg of displayMessages.slice(-recentCount)) {
        const icon = msg.role === "user" ? "👤" : "🤖"
        lines.push(`${icon} ${utils.truncate(msg.text, 60)}`)
      }
    }
  } catch {}
  return lines.join("\n")
}

async function openMenu(api: Api, opencode: OpencodeClient, chatId: number, userId: number, contextKey: string, messageThreadId?: number, replyToMessageId?: number): Promise<void> {
  const sessionId = chatSessions.get(contextKey)
  const title = await getCurrentSessionTitle(opencode, sessionId)
  const model = formatModelLabel(getUserModel(userId))
  const mode = getUserAgentMode(userId)
  const profile = getUserPermissionProfile(userId)
  const scopeMode = getUserScopeMode(userId)
  const dir = await getContextBaseDirectory(opencode, contextKey, sessionId, userId)
  const reply_parameters = replyToMessageId ? { message_id: replyToMessageId, allow_sending_without_reply: true } : undefined
  const msg = await api.sendMessage(chatId, menuMainText(title, model, mode, profile, scopeMode, dir), withThreadId({ reply_markup: menuMainKeyboard(), reply_parameters }, messageThreadId))
  menuStates.set(utils.messageKey(chatId, msg.message_id), { userId, page: 0, sessionIds: [] })
}

async function closeMenuMessage(api: Api, chatId: number, messageId: number): Promise<void> {
  await api.deleteMessage(chatId, messageId).catch(async () => { await api.editMessageText(chatId, messageId, "Menu closed.", { reply_markup: EMPTY_INLINE_KEYBOARD }).catch(() => {}) })
}

function checkOpenCodeCLI(): { installed: boolean; version?: string; path?: string } {
  const whichResult = Bun.spawnSync(["which", "opencode"]); if (whichResult.exitCode !== 0) return { installed: false }
  const binPath = whichResult.stdout.toString().trim()
  const versionResult = Bun.spawnSync(["opencode", "--version"])
  return { installed: true, version: versionResult.exitCode === 0 ? versionResult.stdout.toString().trim() : undefined, path: binPath }
}

async function initializeBot(): Promise<{ bot: Bot; opencode: OpencodeClient; server: { close(): void; url: string } | null }> {
  const cliCheck = checkOpenCodeCLI()
  if (!cliCheck.installed) { console.error("OpenCode CLI not found. Install: curl -fsSL https://opencode.ai/install | bash"); process.exit(1) }
  console.log(`OpenCode CLI: ${cliCheck.version ?? "unknown"} (${cliCheck.path ?? "opencode"})`)
  console.log(`Starting OpenCode server on port ${OPENCODE_PORT}...`)
  let opencode: OpencodeClient
  let server: { close(): void; url: string } | null = null
  try {
    const mcpConfig = OPENCODE_MCP_CONFIG ? JSON.parse(OPENCODE_MCP_CONFIG) as McpConfigMap : undefined
    const result = await createOpencode({ port: OPENCODE_PORT, hostname: "127.0.0.1", ...(mcpConfig ? { config: { mcp: mcpConfig } } : {}) })
    opencode = result.client; server = result.server
    console.log(`OpenCode server ready at ${server.url}`)
  } catch (err) {
    console.warn("OpenCode server already running, connecting...")
    opencode = createOpencodeClient({ baseUrl: `http://127.0.0.1:${OPENCODE_PORT}` })
  }
  // Auto-register OpenAI API key with OpenCode if available
  if (OPENAI_API_KEY) {
    try {
      await opencode.auth.set({ path: { id: "openai" }, body: { type: "api", key: OPENAI_API_KEY } })
      console.log("OpenAI API key registered with OpenCode")
    } catch (err) { console.warn("Failed to register OpenAI API key:", err) }
  }
  const bot = new Bot(TELEGRAM_BOT_TOKEN)
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }))
  const cleanup = (reason: string) => { console.log(`Shutting down (${reason})...`); bot.stop(); server?.close(); db.closeDb() }
  process.once("SIGINT", () => { cleanup("SIGINT"); process.exit(0) })
  process.once("SIGTERM", () => { cleanup("SIGTERM"); process.exit(0) })
  bot.catch((err) => { const msg = String(err); if (msg.includes("query is too old") || msg.includes("message is not modified")) return; console.error("Bot error:", err) })
  return { bot, opencode, server }
}

const { bot, opencode } = await initializeBot()

bot.callbackQuery("abort", async (ctx) => {
  const msg = ctx.callbackQuery?.message; if (!msg) return
  const entry = activeMessages.get(utils.messageKey(msg.chat.id, msg.message_id))
  await ctx.answerCallbackQuery({ text: "Stopped" })
  if (!entry) { await ctx.editMessageReplyMarkup({ reply_markup: idleKeyboard() }).catch(() => {}); return }
  entry.state.aborted = true; entry.resolvePermission?.(); entry.abortController.abort()
  void opencode.session.abort({ path: { id: entry.sessionId }, ...withSessionDirectory(entry.sessionId) }).catch(() => {})
  await ctx.editMessageText("⏹ Stopped.", { reply_markup: idleKeyboard() }).catch(() => {})
})

bot.callbackQuery("menu", async (ctx) => {
  await ctx.answerCallbackQuery()
  const userId = ctx.from?.id; const msg = ctx.callbackQuery?.message; if (!userId || !msg) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(msg.chat, userId, messageThreadId)
  await openMenu(ctx.api, opencode, msg.chat.id, userId, contextKey, messageThreadId, msg.message_id)
})

bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
  const action = ctx.match![1]; const userId = ctx.from?.id; if (!userId) return
  const msg = ctx.callbackQuery?.message; if (!msg) { await ctx.answerCallbackQuery(); return }
  const key = utils.messageKey(msg.chat.id, msg.message_id)
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(msg.chat, userId, messageThreadId)
  const sessionId = chatSessions.get(contextKey)

  if (action === "close") { await ctx.answerCallbackQuery({ text: "Closed" }); menuStates.delete(key); await closeMenuMessage(ctx.api, msg.chat.id, msg.message_id); return }
  if (action === "back") {
    await ctx.answerCallbackQuery()
    const title = await getCurrentSessionTitle(opencode, sessionId)
    const dir = await getContextBaseDirectory(opencode, contextKey, sessionId, userId)
    await ctx.editMessageText(menuMainText(title, formatModelLabel(getUserModel(userId)), getUserAgentMode(userId), getUserPermissionProfile(userId), getUserScopeMode(userId), dir), { reply_markup: menuMainKeyboard() }).catch(() => {})
    return
  }
  if (action === "status") { await ctx.answerCallbackQuery({ text: "Showing status..." }); const title = await getCurrentSessionTitle(opencode, sessionId); const dir = await getContextBaseDirectory(opencode, contextKey, sessionId, userId); const stats = db.loadUsageStats(userId); const bucket = stats.daily.get(utils.getDateKey()) ?? { tokens: 0, cost: 0, messages: 0 }; await ctx.api.sendMessage(msg.chat.id, `Status\nSession: ${title ?? "None"}\nMode: ${getUserAgentMode(userId)}\nModel: ${formatModelLabel(getUserModel(userId)) ?? "default"}\nProfile: ${getUserPermissionProfile(userId)}\nScope: ${getUserScopeMode(userId)}\nDirectory: ${dir}\nUsage (today): ${bucket.tokens} tok · $${bucket.cost.toFixed(3)}`, withThreadId({}, messageThreadId)); return }
  if (action === "new") { await ctx.answerCallbackQuery({ text: "Starting new..." }); const session = await createNewSessionForChat(opencode, contextKey, userId); if (!session) { await ctx.api.sendMessage(msg.chat.id, "Failed.", withThreadId({}, messageThreadId)); return }; await ctx.api.sendMessage(msg.chat.id, `✨ New conversation started\n📁 ${await getContextBaseDirectory(opencode, contextKey, session.id, userId)}`, withThreadId({}, messageThreadId)); return }
  if (action === "clear") { await ctx.answerCallbackQuery({ text: "Clearing..." }); if (sessionId) { await opencode.session.delete({ path: { id: sessionId }, ...withSessionDirectory(sessionId) }).catch(() => {}); sessionTitleCache.delete(sessionId) }; const session = await createNewSessionForChat(opencode, contextKey, userId); if (session) await ctx.api.sendMessage(msg.chat.id, "🧹 Cleared. New conversation started.", withThreadId({}, messageThreadId)); return }
  if (action === "cd") { await ctx.answerCallbackQuery(); menuStates.delete(key); await closeMenuMessage(ctx.api, msg.chat.id, msg.message_id); const baseDir = await getContextBaseDirectory(opencode, contextKey, sessionId, userId); const { text, keyboard } = await renderDirectoryBrowser(contextKey, baseDir); await ctx.api.sendMessage(msg.chat.id, text, withThreadId({ reply_markup: keyboard }, messageThreadId)); return }
  if (action === "model") { await ctx.answerCallbackQuery(); const { providers } = await fetchProviders(opencode); const recentModels = db.loadRecentModels(userId); const currentModel = formatModelLabel(getUserModel(userId)); const kb = new InlineKeyboard(); recentModels.slice(0, 3).forEach((m, i) => { kb.text(`⏱ ${m.label}`, `model:recent:${i}`).row() }); providers.slice(0, 6).forEach((p, i) => { kb.text(p.name, `model:provider:${i}`).row() }); kb.text("⬅ Back", "menu:back").text("✖ Close", "menu:close"); await ctx.editMessageText(`Model selection\nCurrent: ${currentModel ?? "default"}`, { reply_markup: kb }).catch(() => {}); modelMenuStates.set(key, { userId, view: "providers", providers, providerPage: 0, modelPage: 0 }); return }
  if (action === "mode") { await ctx.answerCallbackQuery(); const mode = getUserAgentMode(userId); const kb = new InlineKeyboard().text(mode === "plan" ? "✅ Plan" : "Plan", "mode:plan").text(mode === "build" ? "✅ Build" : "Build", "mode:build").row().text("⬅ Back", "menu:back").text("✖ Close", "menu:close"); await ctx.editMessageText(`Mode: ${mode}`, { reply_markup: kb }).catch(() => {}); modeMenuStates.set(key, { userId }); return }
  if (action === "profile") { await ctx.answerCallbackQuery(); const profile = getUserPermissionProfile(userId); const kb = new InlineKeyboard().text(profile === "strict" ? "✅ Strict" : "Strict", "prof:strict").text(profile === "balanced" ? "✅ Balanced" : "Balanced", "prof:balanced").text(profile === "power" ? "✅ Power" : "Power", "prof:power").row().text("⬅ Back", "menu:back").text("✖ Close", "menu:close"); await ctx.editMessageText(`Permission Profile: ${profile}\n${perms.getProfileDescription(profile)}`, { reply_markup: kb }).catch(() => {}); return }
  if (action === "scope") { await ctx.answerCallbackQuery(); const scopeMode = getUserScopeMode(userId); const kb = new InlineKeyboard().text(scopeMode === "user" ? "✅ User" : "User", "scope:user").text(scopeMode === "thread" ? "✅ Thread" : "Thread", "scope:thread").text(scopeMode === "shared" ? "✅ Shared" : "Shared", "scope:shared").row().text("⬅ Back", "menu:back").text("✖ Close", "menu:close"); await ctx.editMessageText(`Group Scope: ${scopeMode}\n${scopeLib.getScopeModeDescription(scopeMode)}`, { reply_markup: kb }).catch(() => {}); return }
  if (action === "auth") { await ctx.answerCallbackQuery(); const { data } = await opencode.provider.auth(); const authData = (data ?? {}) as Record<string, Array<{ type: "oauth" | "api"; label: string }>>; const kb = new InlineKeyboard(); const { data: providerData } = await opencode.provider.list(); (providerData?.all ?? []).forEach(p => { (authData[p.id] ?? []).forEach((m, i) => { kb.text(`${p.name} (${m.label})`, `auth:${m.type}:${p.id}:${i}`).row() }) }); kb.text("✖ Close", "auth:close"); await ctx.api.sendMessage(msg.chat.id, "Choose a provider:", withThreadId({ reply_markup: kb }, messageThreadId)); return }
  if (action === "workflow") { await ctx.answerCallbackQuery(); await ctx.editMessageText("Quick Workflows", { reply_markup: workflowMenuKeyboard() }).catch(() => {}); workflowStates.set(key, { userId }); return }
  if (action === "undo") { await ctx.answerCallbackQuery(); const entries = undoLib.getRecentUndos(userId); if (entries.length === 0) { await ctx.api.sendMessage(msg.chat.id, "Nothing to undo.", withThreadId({}, messageThreadId)); return }; await ctx.editMessageText("Undo Stack", { reply_markup: undoMenuKeyboard(entries) }).catch(() => {}); return }
  if (action === "export") { await ctx.answerCallbackQuery(); if (!sessionId) { await ctx.api.sendMessage(msg.chat.id, "No active session.", withThreadId({}, messageThreadId)); return }; await ctx.editMessageText("Export Format", { reply_markup: exportMenuKeyboard() }).catch(() => {}); return }
  if (action === "history") { await ctx.answerCallbackQuery(); if (!sessionId) { await ctx.api.sendMessage(msg.chat.id, "No active session.", withThreadId({}, messageThreadId)); return }; const entries = db.getSessionHistory(sessionId, 5, 0); const lines = entries.map(e => `${e.role === "user" ? "👤" : "🤖"} ${utils.truncate(e.text, 50)}`); await ctx.editMessageText(`History\n\n${lines.join("\n") || "(empty)"}`, { reply_markup: historyMenuKeyboard(entries.length >= 5, 0) }).catch(() => {}); historyBrowseStates.set(key, { sessionId, page: 0 }); return }
  if (action === "git") { await ctx.answerCallbackQuery(); await ctx.api.sendMessage(msg.chat.id, constants.GIT_USAGE_TEXT, withThreadId({}, messageThreadId)); return }
  if (action === "cost") { await ctx.answerCallbackQuery(); const stats = db.loadUsageStats(userId); const bucket = stats.daily.get(utils.getDateKey()) ?? { tokens: 0, cost: 0, messages: 0 }; await ctx.api.sendMessage(msg.chat.id, `📊 Usage\nToday: ${bucket.tokens} tok · $${bucket.cost.toFixed(3)} · ${bucket.messages} msgs\nTotal: ${stats.totalTokens} tok · $${stats.totalCost.toFixed(3)} · ${stats.totalMessages} msgs`, withThreadId({}, messageThreadId)); return }
  if (action === "sessions" || action === "next" || action === "prev" || action === "all" || action === "folder") {
    await ctx.answerCallbackQuery()
    const state = menuStates.get(key); const currentPage = state?.page ?? 0
    const showAll = action === "all" ? true : action === "folder" ? false : (state?.showAllSessions ?? false)
    const nextPage = action === "next" ? currentPage + 1 : action === "prev" ? currentPage - 1 : 0
    const dir = await getContextBaseDirectory(opencode, contextKey, sessionId, userId)
    const menu = await buildSessionsMenu(opencode, dir, sessionId, nextPage, showAll, true)
    menuStates.set(key, { userId, page: nextPage, sessionIds: menu.sessionIds, showAllSessions: showAll })
    await ctx.editMessageText(menu.text, { reply_markup: menu.keyboard }).catch(() => {})
    return
  }
  if (action.startsWith("switch:")) {
    const index = Number(action.split(":")[1]); const state = menuStates.get(key)
    if (!state || !Number.isInteger(index)) { await ctx.answerCallbackQuery({ text: "Menu expired" }); return }
    const newSessionId = state.sessionIds[index]; if (!newSessionId) { await ctx.answerCallbackQuery({ text: "Not found" }); return }
    await ctx.answerCallbackQuery({ text: "Switching..." })
    chatSessions.set(contextKey, newSessionId); db.saveChatSession(contextKey, newSessionId)
    const title = await getCurrentSessionTitle(opencode, newSessionId) ?? "Untitled"
    const dir = getSessionDirectoryHint(newSessionId) ?? undefined
    const context = await formatSessionContext(opencode, newSessionId, title, dir)
    await ctx.api.sendMessage(msg.chat.id, context, withThreadId({}, messageThreadId))
    return
  }
  await ctx.answerCallbackQuery()
})

bot.callbackQuery(/^cd:(.+)$/, async (ctx) => {
  const action = ctx.match![1]; const userId = ctx.from?.id; const msg = ctx.callbackQuery?.message
  if (!userId || !msg) { await ctx.answerCallbackQuery(); return }
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(msg.chat, userId, messageThreadId)
  const state = directoryBrowseStates.get(contextKey)
  const baseDir = state?.baseDir ?? utils.getHomeDirectory()
  const [command, param] = action.split(":")
  const render = async (dir: string, page = 0, notice?: string) => { const { text, keyboard } = await renderDirectoryBrowser(contextKey, dir, page, notice); await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => {}) }
  if (command === "noop") { await ctx.answerCallbackQuery(); return }
  if (command === "close") { directoryBrowseStates.delete(contextKey); await ctx.editMessageReplyMarkup({ reply_markup: EMPTY_INLINE_KEYBOARD }).catch(() => {}); await ctx.answerCallbackQuery({ text: "Closed" }); return }
  if (command === "up") { await render(path.dirname(baseDir)); await ctx.answerCallbackQuery(); return }
  if (command === "home") { await render(utils.getHomeDirectory()); await ctx.answerCallbackQuery(); return }
  if (command === "page") { await render(baseDir, Number(param ?? "0")); await ctx.answerCallbackQuery(); return }
  if (command === "nav") { const entry = state?.entries[Number(param ?? "-1")]; if (!entry) { await ctx.answerCallbackQuery({ text: "Invalid" }); return }; await render(entry.path); await ctx.answerCallbackQuery(); return }
  if (command === "recent") { const dir = state?.recents[Number(param ?? "-1")]; if (!dir) { await ctx.answerCallbackQuery({ text: "Invalid" }); return }; await render(dir); await ctx.answerCallbackQuery(); return }
  if (command === "reset") { contextDirectories.delete(contextKey); setUserDefaultDirectory(userId, null); await render(utils.getHomeDirectory(), 0, "Directory reset."); await ctx.answerCallbackQuery(); return }
  if (command === "select") { contextDirectories.set(contextKey, baseDir); setUserDefaultDirectory(userId, baseDir); trackRecentDirectory(contextKey, baseDir); const session = await createNewSessionForChat(opencode, contextKey, userId); if (session) { await ctx.deleteMessage().catch(() => {}); await ctx.api.sendMessage(msg.chat.id, `📁 Selected: ${baseDir}\n✨ New session started`, withThreadId({}, messageThreadId)) }; await ctx.answerCallbackQuery({ text: "Selected" }); return }
  if (command === "setdefault") { setUserDefaultDirectory(userId, baseDir); trackRecentDirectory(contextKey, baseDir); await render(baseDir, state?.page ?? 0, `⭐ Default set`); await ctx.answerCallbackQuery({ text: "Default set" }); return }
  await ctx.answerCallbackQuery()
})

bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
  const action = ctx.match![1]; const userId = ctx.from?.id; const msg = ctx.callbackQuery?.message
  if (!userId || !msg) { await ctx.answerCallbackQuery(); return }
  const key = utils.messageKey(msg.chat.id, msg.message_id); const state = modelMenuStates.get(key)
  if (!state) { await ctx.answerCallbackQuery(); return }
  await ctx.answerCallbackQuery()
  if (action === "close") { modelMenuStates.delete(key); await closeMenuMessage(ctx.api, msg.chat.id, msg.message_id); return }
  if (action.startsWith("recent:")) { const index = Number(action.split(":")[1]); const recent = db.loadRecentModels(userId)[index]; if (!recent) return; const settings = getUserSettings(userId); settings.model = { providerID: recent.providerID, modelID: recent.modelID }; saveUserSettings(userId, settings); await ctx.api.sendMessage(msg.chat.id, `✅ Model: ${recent.label}`); return }
  if (action.startsWith("provider:")) { const index = Number(action.split(":")[1]); const provider = state.providers[index]; if (!provider) return; state.view = "models"; state.providerId = provider.id; state.modelPage = 0; const kb = new InlineKeyboard(); provider.models.slice(0, 6).forEach((m, i) => { kb.text(m.name, `model:choose:${i}`).row() }); kb.text("⬅ Back", "model:back").text("✖ Close", "model:close"); await ctx.editMessageText(`${provider.name} models`, { reply_markup: kb }).catch(() => {}); return }
  if (action === "back") { state.view = "providers"; const kb = new InlineKeyboard(); db.loadRecentModels(userId).slice(0, 3).forEach((m, i) => { kb.text(`⏱ ${m.label}`, `model:recent:${i}`).row() }); state.providers.slice(0, 6).forEach((p, i) => { kb.text(p.name, `model:provider:${i}`).row() }); kb.text("⬅ Back", "menu:back").text("✖ Close", "model:close"); await ctx.editMessageText(`Model selection\nCurrent: ${formatModelLabel(getUserModel(userId)) ?? "default"}`, { reply_markup: kb }).catch(() => {}); return }
  if (action.startsWith("choose:")) { const index = Number(action.split(":")[1]); const provider = state.providers.find(p => p.id === state.providerId); const model = provider?.models[index]; if (!model || !provider) return; const settings = getUserSettings(userId); settings.model = { providerID: provider.id, modelID: model.id }; saveUserSettings(userId, settings); trackRecentModel(userId, provider.id, model.id); await ctx.api.sendMessage(msg.chat.id, `✅ Model: ${model.name}`); return }
})

bot.callbackQuery(/^mode:(plan|build)$/, async (ctx) => {
  const mode = ctx.match![1] as AgentMode; const userId = ctx.from?.id; if (!userId) return
  const settings = getUserSettings(userId); settings.agentMode = mode; saveUserSettings(userId, settings)
  await ctx.answerCallbackQuery({ text: `Mode: ${mode}` })
  const kb = new InlineKeyboard().text(mode === "plan" ? "✅ Plan" : "Plan", "mode:plan").text(mode === "build" ? "✅ Build" : "Build", "mode:build").row().text("⬅ Back", "menu:back").text("✖ Close", "menu:close")
  await ctx.editMessageText(`Mode: ${mode}`, { reply_markup: kb }).catch(() => {})
})

bot.callbackQuery(/^prof:(strict|balanced|power)$/, async (ctx) => {
  const profile = ctx.match![1] as PermissionProfile; const userId = ctx.from?.id; if (!userId) return
  const settings = getUserSettings(userId); settings.permissionProfile = profile; saveUserSettings(userId, settings)
  await ctx.answerCallbackQuery({ text: `Profile: ${profile}` })
  const kb = new InlineKeyboard().text(profile === "strict" ? "✅ Strict" : "Strict", "prof:strict").text(profile === "balanced" ? "✅ Balanced" : "Balanced", "prof:balanced").text(profile === "power" ? "✅ Power" : "Power", "prof:power").row().text("⬅ Back", "menu:back").text("✖ Close", "menu:close")
  await ctx.editMessageText(`Permission Profile: ${profile}\n${perms.getProfileDescription(profile)}`, { reply_markup: kb }).catch(() => {})
})

bot.callbackQuery(/^scope:(user|thread|shared)$/, async (ctx) => {
  const scopeMode = ctx.match![1] as ScopeMode; const userId = ctx.from?.id; if (!userId) return
  const settings = getUserSettings(userId); settings.scopeMode = scopeMode; saveUserSettings(userId, settings)
  await ctx.answerCallbackQuery({ text: `Scope: ${scopeMode}` })
  const kb = new InlineKeyboard().text(scopeMode === "user" ? "✅ User" : "User", "scope:user").text(scopeMode === "thread" ? "✅ Thread" : "Thread", "scope:thread").text(scopeMode === "shared" ? "✅ Shared" : "Shared", "scope:shared").row().text("⬅ Back", "menu:back").text("✖ Close", "menu:close")
  await ctx.editMessageText(`Group Scope: ${scopeMode}\n${scopeLib.getScopeModeDescription(scopeMode)}`, { reply_markup: kb }).catch(() => {})
})

bot.callbackQuery(/^wf:(.+)$/, async (ctx) => {
  const wfId = ctx.match![1]; const userId = ctx.from?.id; const msg = ctx.callbackQuery?.message
  if (!userId || !msg) { await ctx.answerCallbackQuery(); return }
  const wf = workflows.getWorkflow(wfId); if (!wf) { await ctx.answerCallbackQuery({ text: "Not found" }); return }
  await ctx.answerCallbackQuery({ text: `Starting ${wf.name}...` })
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(msg.chat, userId, messageThreadId)
  if (wf.mode) { const settings = getUserSettings(userId); settings.agentMode = wf.mode; saveUserSettings(userId, settings) }
  await startStreamingReply({ opencode, ctx: { api: ctx.api, chat: msg.chat, reply: (t, o) => ctx.api.sendMessage(msg.chat.id, t, o) }, userId, userText: wf.prompt, parts: [{ type: "text", text: wf.prompt }], contextKey, messageThreadId, initialText: `${wf.icon} ${wf.name}...` })
})

bot.callbackQuery(/^undo:(.+)$/, async (ctx) => {
  const undoId = ctx.match![1]; const userId = ctx.from?.id; const msg = ctx.callbackQuery?.message
  if (!userId || !msg) { await ctx.answerCallbackQuery(); return }
  const entries = undoLib.getRecentUndos(userId); const entry = entries.find(e => e.id === undoId)
  if (!entry) { await ctx.answerCallbackQuery({ text: "Not found" }); return }
  await ctx.answerCallbackQuery({ text: "Undoing..." })
  const result = await undoLib.executeUndo(entry)
  const messageThreadId = getMessageThreadId(ctx)
  await ctx.api.sendMessage(msg.chat.id, result.success ? `✅ ${result.message}` : `❌ ${result.message}`, withThreadId({}, messageThreadId))
})

bot.callbackQuery(/^exp:(md|json|html)$/, async (ctx) => {
  const format = ctx.match![1] as "md" | "json" | "html"; const userId = ctx.from?.id; const msg = ctx.callbackQuery?.message
  if (!userId || !msg) { await ctx.answerCallbackQuery(); return }
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(msg.chat, userId, messageThreadId)
  const sessionId = chatSessions.get(contextKey)
  if (!sessionId) { await ctx.answerCallbackQuery({ text: "No session" }); return }
  await ctx.answerCallbackQuery({ text: "Exporting..." })
  const title = await getCurrentSessionTitle(opencode, sessionId) ?? "Conversation"
  const formatMap = { md: "markdown", json: "json", html: "html" } as const
  const content = exportLib.exportSession(sessionId, title, { format: formatMap[format], redactSecrets: getUserSettings(userId).secretRedaction !== false })
  const filename = exportLib.getExportFilename(title, formatMap[format])
  await ctx.api.sendDocument(msg.chat.id, new Blob([content], { type: "text/plain" }) as any, withThreadId({ caption: `📤 ${filename}` }, messageThreadId))
})

bot.callbackQuery(/^hist:(.+)$/, async (ctx) => {
  const action = ctx.match![1]; const userId = ctx.from?.id; const msg = ctx.callbackQuery?.message
  if (!userId || !msg) { await ctx.answerCallbackQuery(); return }
  const key = utils.messageKey(msg.chat.id, msg.message_id); const state = historyBrowseStates.get(key)
  if (!state) { await ctx.answerCallbackQuery({ text: "Expired" }); return }
  await ctx.answerCallbackQuery()
  if (action.startsWith("page:")) { const page = Number(action.split(":")[1]); const entries = db.getSessionHistory(state.sessionId, 5, page * 5); const lines = entries.map(e => `${e.role === "user" ? "👤" : "🤖"} ${utils.truncate(e.text, 50)}`); state.page = page; await ctx.editMessageText(`History (page ${page + 1})\n\n${lines.join("\n") || "(empty)"}`, { reply_markup: historyMenuKeyboard(entries.length >= 5, page) }).catch(() => {}); return }
  if (action === "search") { await ctx.api.sendMessage(msg.chat.id, "Send search query:"); return }
})

bot.callbackQuery(/^perm:(once|always|reject)$/, async (ctx) => {
  const response = ctx.match![1] as "once" | "always" | "reject"; const msg = ctx.callbackQuery?.message
  if (!msg) return; const entry = activeMessages.get(utils.messageKey(msg.chat.id, msg.message_id))
  await ctx.answerCallbackQuery({ text: response === "reject" ? "Skipped" : "Allowed" })
  if (!entry?.state.pendingPermission) return
  await opencode.postSessionIdPermissionsPermissionId({ path: { id: entry.sessionId, permissionID: entry.state.pendingPermission.id }, body: { response } })
  entry.state.pendingPermission = null; entry.state.phase = "tools"; entry.resolvePermission?.(); entry.resolvePermission = undefined
  const queued = pendingNudges.get(entry.sessionId); if (queued?.length) { pendingNudges.delete(entry.sessionId); await opencode.session.promptAsync({ path: { id: entry.sessionId }, ...withSessionDirectory(entry.sessionId), body: { noReply: true, parts: [{ type: "text", text: queued.join("\n") }] } }).catch(() => {}) }
  await ctx.editMessageReplyMarkup({ reply_markup: abortKeyboard() }).catch(() => {})
})

bot.callbackQuery(/^auth:(.+)$/, async (ctx) => {
  const action = ctx.match![1]; const userId = ctx.from?.id; const msg = ctx.callbackQuery?.message
  if (!userId || !msg) return; const messageThreadId = getMessageThreadId(ctx)
  const parts = action.split(":")
  if (parts[0] === "close") { await ctx.answerCallbackQuery({ text: "Closed" }); await ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}); return }
  if (parts[0] === "api") { pendingApiAuth.set(userId, { providerId: parts[1], methodIndex: Number(parts[2] ?? "0"), type: "api" }); await ctx.answerCallbackQuery(); await ctx.api.sendMessage(msg.chat.id, `Send API key for ${parts[1]}. It will be deleted.`, withThreadId({}, messageThreadId)); return }
  if (parts[0] === "oauth") {
    await ctx.answerCallbackQuery()
    try {
      const { data } = await opencode.provider.oauth.authorize({ path: { id: parts[1] }, body: { method: Number(parts[2] ?? "0") } })
      if (!data) { await ctx.api.sendMessage(msg.chat.id, "OAuth failed.", withThreadId({}, messageThreadId)); return }
      if (data.method === "code") { pendingOauthAuth.set(userId, { providerId: parts[1], methodIndex: Number(parts[2] ?? "0"), type: "oauth" }); await ctx.api.sendMessage(msg.chat.id, `${data.instructions ?? ""}\n\nOpen: ${data.url}\n\nThen: /auth code <code>`, withThreadId({}, messageThreadId)) }
      else await ctx.api.sendMessage(msg.chat.id, `${data.instructions ?? ""}\n\nOpen: ${data.url}`, withThreadId({ reply_markup: new InlineKeyboard().text("✅ Complete", `auth:complete:${parts[1]}:${parts[2]}`) }, messageThreadId))
    } catch { await ctx.api.sendMessage(msg.chat.id, "OAuth failed.", withThreadId({}, messageThreadId)) }
    return
  }
  if (parts[0] === "complete") { await ctx.answerCallbackQuery(); try { await opencode.provider.oauth.callback({ path: { id: parts[1] }, body: { method: Number(parts[2] ?? "0") } }); await ctx.api.sendMessage(msg.chat.id, `✅ Connected: ${parts[1]}`, withThreadId({}, messageThreadId)) } catch { await ctx.api.sendMessage(msg.chat.id, "OAuth completion failed.", withThreadId({}, messageThreadId)) }; return }
  await ctx.answerCallbackQuery()
})

bot.callbackQuery(/^git:(confirm|cancel):(.+)$/, async (ctx) => {
  const action = ctx.match![1]; const id = ctx.match![2]; const userId = ctx.from?.id; if (!userId) return
  const pending = pendingGitCommands.get(id)
  if (!pending || pending.userId !== userId || Date.now() - pending.createdAt > constants.GIT_CONFIRM_TTL_MS) { await ctx.answerCallbackQuery({ text: "Expired" }); return }
  pendingGitCommands.delete(id)
  if (action === "cancel") { await ctx.answerCallbackQuery({ text: "Canceled" }); return }
  await ctx.answerCallbackQuery({ text: "Running..." })
  const headBefore = (await runGitCommand(["rev-parse", "HEAD"])).stdout
  const result = await runGitCommand(pending.args)
  if (result.code === 0 && headBefore) await undoLib.createGitUndoEntry(userId, pending.args.join(" "), headBefore)
  await ctx.reply(utils.formatCodeBlockMarkdown(result.stdout || result.stderr || "(no output)"), withThreadId({ parse_mode: constants.TELEGRAM_PARSE_MODE }, getMessageThreadId(ctx)))
})

bot.on("callback_query:data", async (ctx) => { await ctx.answerCallbackQuery() })

bot.command("start", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const baseDir = await getContextBaseDirectory(opencode, contextKey, chatSessions.get(contextKey), userId)
  await ctx.reply(`OpenCode\n\n📁 ${baseDir}\n\nJust send a message to start.`, withThreadId({ reply_markup: idleKeyboard() }, messageThreadId))
})

bot.command("help", async (ctx) => { await ctx.reply(constants.HELP_TEXT, withThreadId({}, getMessageThreadId(ctx))) })

bot.command("menu", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  await openMenu(ctx.api, opencode, ctx.chat.id, userId, contextKey, messageThreadId, ctx.message?.message_id)
})

bot.command("new", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const session = await createNewSessionForChat(opencode, contextKey, userId)
  if (!session) { await ctx.reply("Failed.", withThreadId({}, messageThreadId)); return }
  await ctx.reply(`✨ New conversation\n📁 ${await getContextBaseDirectory(opencode, contextKey, session.id, userId)}`, withThreadId({}, messageThreadId))
})

bot.command("cd", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const args = utils.parseCommandArgs(ctx.message?.text ?? "").slice(1)
  const input = args.join(" ").trim()
  const sessionId = chatSessions.get(contextKey)
  const baseDir = await getContextBaseDirectory(opencode, contextKey, sessionId, userId)
  if (!input) { const { text, keyboard } = await renderDirectoryBrowser(contextKey, baseDir); await ctx.reply(text, withThreadId({ reply_markup: keyboard }, messageThreadId)); return }
  if (input === "reset") { contextDirectories.delete(contextKey); setUserDefaultDirectory(userId, null); await ctx.reply("Directory reset.", withThreadId({}, messageThreadId)); return }
  const resolved = utils.resolveDirectoryInput(input, baseDir)
  const info = await stat(resolved).catch(() => null)
  if (!info?.isDirectory()) { await ctx.reply(`Invalid: ${resolved}`, withThreadId({}, messageThreadId)); return }
  contextDirectories.set(contextKey, resolved); setUserDefaultDirectory(userId, resolved); trackRecentDirectory(contextKey, resolved)
  await ctx.reply(`📁 ${resolved}`, withThreadId({}, messageThreadId))
})

bot.command("model", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  await openMenu(ctx.api, opencode, ctx.chat.id, userId, contextKey, messageThreadId)
})

bot.command("mode", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const mode = getUserAgentMode(userId)
  const messageThreadId = getMessageThreadId(ctx)
  const kb = new InlineKeyboard().text(mode === "plan" ? "✅ Plan" : "Plan", "mode:plan").text(mode === "build" ? "✅ Build" : "Build", "mode:build").row().text("✖ Close", "menu:close")
  await ctx.reply(`Mode: ${mode}`, withThreadId({ reply_markup: kb }, messageThreadId))
})

bot.command("profile", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const profile = getUserPermissionProfile(userId)
  const messageThreadId = getMessageThreadId(ctx)
  const kb = new InlineKeyboard().text(profile === "strict" ? "✅ Strict" : "Strict", "prof:strict").text(profile === "balanced" ? "✅ Balanced" : "Balanced", "prof:balanced").text(profile === "power" ? "✅ Power" : "Power", "prof:power").row().text("✖ Close", "menu:close")
  await ctx.reply(`Profile: ${profile}\n${perms.getProfileDescription(profile)}`, withThreadId({ reply_markup: kb }, messageThreadId))
})

bot.command("scope", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const scopeMode = getUserScopeMode(userId)
  const messageThreadId = getMessageThreadId(ctx)
  const kb = new InlineKeyboard().text(scopeMode === "user" ? "✅ User" : "User", "scope:user").text(scopeMode === "thread" ? "✅ Thread" : "Thread", "scope:thread").text(scopeMode === "shared" ? "✅ Shared" : "Shared", "scope:shared").row().text("✖ Close", "menu:close")
  await ctx.reply(`Scope: ${scopeMode}\n${scopeLib.getScopeModeDescription(scopeMode)}`, withThreadId({ reply_markup: kb }, messageThreadId))
})

bot.command("auth", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const args = utils.parseCommandArgs(ctx.message?.text ?? "").slice(1)
  if (args[0] === "cancel") { pendingApiAuth.delete(userId); pendingOauthAuth.delete(userId); await ctx.reply("Canceled.", withThreadId({}, messageThreadId)); return }
  if (args[0] === "status") { const { data } = await opencode.provider.list(); await ctx.reply(`Connected: ${(data?.connected ?? []).join(", ") || "none"}`, withThreadId({}, messageThreadId)); return }
  if (args[0] === "code") {
    const code = args.slice(1).join(" ").trim(); const pending = pendingOauthAuth.get(userId)
    if (!pending) { await ctx.reply("No OAuth flow. Use /auth first.", withThreadId({}, messageThreadId)); return }
    pendingOauthAuth.delete(userId)
    try { await opencode.provider.oauth.callback({ path: { id: pending.providerId }, body: { method: pending.methodIndex, code } }); await ctx.reply(`✅ Connected: ${pending.providerId}`, withThreadId({}, messageThreadId)) }
    catch { await ctx.reply("OAuth failed.", withThreadId({}, messageThreadId)) }
    return
  }
  const { data } = await opencode.provider.auth(); const authData = (data ?? {}) as Record<string, Array<{ type: "oauth" | "api"; label: string }>>
  const kb = new InlineKeyboard(); const { data: providerData } = await opencode.provider.list()
  ;(providerData?.all ?? []).forEach(p => { (authData[p.id] ?? []).forEach((m, i) => { kb.text(`${p.name} (${m.label})`, `auth:${m.type}:${p.id}:${i}`).row() }) })
  kb.text("✖ Close", "auth:close")
  await ctx.reply("Choose provider:", withThreadId({ reply_markup: kb }, messageThreadId))
})

bot.command("git", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const args = utils.parseCommandArgs(ctx.message?.text ?? "").slice(1)
  if (args.length === 0) { await ctx.reply(constants.GIT_USAGE_TEXT, withThreadId({}, messageThreadId)); return }
  const cmd = args[0]
  if (cmd === "changes") {
    const [statusRes, diffRes, diffCachedRes] = await Promise.all([runGitCommand(["status", "--porcelain", "-b"]), runGitCommand(["diff", "--stat"]), runGitCommand(["diff", "--stat", "--cached"])])
    const sections = [statusRes.stdout, diffCachedRes.stdout ? `Staged:\n${diffCachedRes.stdout}` : "", diffRes.stdout ? `Working:\n${diffRes.stdout}` : ""].filter(Boolean)
    await ctx.reply(utils.formatCodeBlockMarkdown(sections.join("\n\n") || "(no changes)"), withThreadId({ parse_mode: constants.TELEGRAM_PARSE_MODE }, messageThreadId))
    return
  }
  if (constants.GIT_SAFE_COMMANDS.has(cmd)) { const result = await runGitCommand(args); await ctx.reply(utils.formatCodeBlockMarkdown(result.stdout || result.stderr || "(no output)"), withThreadId({ parse_mode: constants.TELEGRAM_PARSE_MODE }, messageThreadId)); return }
  if (constants.GIT_CONFIRM_COMMANDS.has(cmd)) { const id = crypto.randomUUID(); pendingGitCommands.set(id, { userId, args, createdAt: Date.now() }); await ctx.reply(`⚠️ Run: git ${args.join(" ")}?`, withThreadId({ reply_markup: new InlineKeyboard().text("✅ Confirm", `git:confirm:${id}`).text("❌ Cancel", `git:cancel:${id}`) }, messageThreadId)); return }
  await ctx.reply("Unsupported command.", withThreadId({}, messageThreadId))
})

bot.command("diff", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const sessionId = chatSessions.get(contextKey)
  if (!sessionId) { await ctx.reply("No session.", withThreadId({}, messageThreadId)); return }
  const { data } = await opencode.session.diff({ path: { id: sessionId }, ...withSessionDirectory(sessionId) })
  const diffs = data ?? []
  if (diffs.length === 0) { await ctx.reply("No changes.", withThreadId({}, messageThreadId)); return }
  const lines = diffs.map(d => `${d.file}\n  +${d.additions} -${d.deletions}`)
  await ctx.reply(utils.formatCodeBlockMarkdown(lines.join("\n")), withThreadId({ parse_mode: constants.TELEGRAM_PARSE_MODE }, messageThreadId))
})

bot.command("compact", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const sessionId = chatSessions.get(contextKey)
  if (!sessionId) { await ctx.reply("No session.", withThreadId({}, messageThreadId)); return }
  const msg = await ctx.reply("🗜 Compacting...", withThreadId({}, messageThreadId))
  try { await opencode.session.summarize({ path: { id: sessionId }, ...withSessionDirectory(sessionId) }); await ctx.api.editMessageText(ctx.chat.id, msg.message_id, "✅ Compacted.").catch(() => {}) }
  catch { await ctx.api.editMessageText(ctx.chat.id, msg.message_id, "Failed.").catch(() => {}) }
})

bot.command("cost", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const stats = db.loadUsageStats(userId)
  const bucket = stats.daily.get(utils.getDateKey()) ?? { tokens: 0, cost: 0, messages: 0 }
  await ctx.reply(`📊 Usage\nToday: ${bucket.tokens} tok · $${bucket.cost.toFixed(3)} · ${bucket.messages} msgs\nTotal: ${stats.totalTokens} tok · $${stats.totalCost.toFixed(3)} · ${stats.totalMessages} msgs`, withThreadId({}, messageThreadId))
})

bot.command("export", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const sessionId = chatSessions.get(contextKey)
  if (!sessionId) { await ctx.reply("No session.", withThreadId({}, messageThreadId)); return }
  await ctx.reply("Export format:", withThreadId({ reply_markup: exportMenuKeyboard() }, messageThreadId))
})

bot.command("history", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const sessionId = chatSessions.get(contextKey)
  if (!sessionId) { await ctx.reply("No session.", withThreadId({}, messageThreadId)); return }
  const args = utils.parseCommandArgs(ctx.message?.text ?? "").slice(1)
  const query = args.join(" ").trim()
  const entries = query ? db.searchHistory(sessionId, query, 10) : db.getSessionHistory(sessionId, 10, 0)
  const lines = entries.map(e => `${e.role === "user" ? "👤" : "🤖"} ${utils.truncate(e.text, 60)}`)
  await ctx.reply(`History${query ? ` (search: ${query})` : ""}\n\n${lines.join("\n") || "(empty)"}`, withThreadId({ reply_markup: historyMenuKeyboard(entries.length >= 10, 0) }, messageThreadId))
})

bot.command("undo", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const result = await undoLib.undoLast(userId)
  await ctx.reply(result.success ? `✅ ${result.message}` : `❌ ${result.message}`, withThreadId({}, messageThreadId))
})

bot.command("workflow", async (ctx) => {
  const messageThreadId = getMessageThreadId(ctx)
  await ctx.reply("Quick Workflows:", withThreadId({ reply_markup: workflowMenuKeyboard() }, messageThreadId))
})

bot.command("sessions", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const args = utils.parseCommandArgs(ctx.message?.text ?? "").slice(1)
  const subcommand = args[0]?.toLowerCase()
  const currentSessionId = chatSessions.get(contextKey)
  const dir = await getContextBaseDirectory(opencode, contextKey, currentSessionId, userId)

  if (!subcommand || subcommand === "all") {
    const showAll = subcommand === "all"
    const menu = await buildSessionsMenu(opencode, dir, currentSessionId, 0, showAll, false)
    if (menu.sessionIds.length === 0) { await ctx.reply(showAll ? "No sessions." : "No sessions in this folder.", withThreadId({}, messageThreadId)); return }
    const msg = await ctx.reply(menu.text, withThreadId({ reply_markup: menu.keyboard }, messageThreadId))
    menuStates.set(utils.messageKey(ctx.chat.id, msg.message_id), { userId, page: 0, sessionIds: menu.sessionIds, showAllSessions: showAll })
    return
  }

  await ctx.reply(`Unknown: ${subcommand}\nUsage: /sessions [all]`, withThreadId({}, messageThreadId))
})

bot.command("status", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const sessionId = chatSessions.get(contextKey)
  const title = sessionId ? await getCurrentSessionTitle(opencode, sessionId) : null
  const dir = await getContextBaseDirectory(opencode, contextKey, sessionId, userId)
  const model = formatModelLabel(getUserModel(userId))
  const mode = getUserAgentMode(userId)
  const profile = getUserPermissionProfile(userId)
  const scopeMode = getUserScopeMode(userId)
  const stats = db.loadUsageStats(userId)
  const lines = [
    `📊 Status`,
    `Session: ${title ?? "None"}`,
    `Directory: ${utils.formatShortPath(dir)}`,
    `Model: ${model ?? "default"}`,
    `Mode: ${mode} | Profile: ${profile} | Scope: ${scopeMode}`,
    `Usage: $${stats.totalCost.toFixed(4)}`,
  ]
  await ctx.reply(lines.join("\n"), withThreadId({}, messageThreadId))
})

bot.on("message:photo", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const photo = ctx.message.photo?.at(-1); if (!photo) return
  if (photo.file_size && photo.file_size > constants.MAX_ATTACHMENT_BYTES) { await ctx.reply("Image too large.", withThreadId({}, messageThreadId)); return }
  try {
    const buffer = await fetchTelegramFile(ctx.api, photo.file_id)
    const dataUrl = toDataUrl(buffer, "image/jpeg")
    const caption = ctx.message.caption?.trim() || "What is in this image?"
    await startStreamingReply({ opencode, ctx, userId, userText: caption, parts: [{ type: "file", mime: "image/jpeg", url: dataUrl, filename: "photo.jpg" }, { type: "text", text: caption }], contextKey, messageThreadId, initialText: "🖼 Analyzing..." })
  } catch (err) { console.error("Photo failed:", err); await ctx.reply("Failed.", withThreadId({}, messageThreadId)) }
})

bot.on("message:document", async (ctx) => {
  const userId = ctx.from?.id; const doc = ctx.message.document; if (!userId || !doc) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  if (doc.file_size && doc.file_size > constants.MAX_ATTACHMENT_BYTES) { await ctx.reply("File too large.", withThreadId({}, messageThreadId)); return }
  const ext = doc.file_name ? path.extname(doc.file_name).toLowerCase() : ""
  const isImage = doc.mime_type?.startsWith("image/")
  const isText = constants.TEXT_FILE_EXTENSIONS.has(ext) || constants.SUPPORTED_FILE_TYPES.has(doc.mime_type ?? "")
  if (!isImage && !isText) { await ctx.reply("Unsupported file type.", withThreadId({}, messageThreadId)); return }
  try {
    const buffer = await fetchTelegramFile(ctx.api, doc.file_id)
    const caption = ctx.message.caption?.trim() || (isImage ? "What is in this image?" : "Analyze this file")
    if (isImage) {
      const dataUrl = toDataUrl(buffer, doc.mime_type ?? "image/png")
      await startStreamingReply({ opencode, ctx, userId, userText: caption, parts: [{ type: "file", mime: doc.mime_type ?? "image/png", url: dataUrl, filename: doc.file_name ?? "image" }, { type: "text", text: caption }], contextKey, messageThreadId, initialText: "🖼 Analyzing..." })
    } else {
      const content = buffer.toString("utf-8")
      const prompt = `${caption}\n\nFile: ${doc.file_name}\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\``
      await startStreamingReply({ opencode, ctx, userId, userText: prompt, parts: [{ type: "text", text: prompt }], contextKey, messageThreadId, initialText: "📄 Analyzing..." })
    }
  } catch (err) { console.error("Document failed:", err); await ctx.reply("Failed.", withThreadId({}, messageThreadId)) }
})

bot.on("message:voice", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const voice = ctx.message.voice; if (!voice) return
  if (voice.file_size && voice.file_size > constants.MAX_ATTACHMENT_BYTES) { await ctx.reply("Voice too large.", withThreadId({}, messageThreadId)); return }
  if (!OPENAI_API_KEY) { await ctx.reply("Voice requires OPENAI_API_KEY.", withThreadId({}, messageThreadId)); return }
  const status = await ctx.reply("🎤 Transcribing...", withThreadId({}, messageThreadId))
  try {
    const buffer = await fetchTelegramFile(ctx.api, voice.file_id)
    const transcript = await transcribeVoice(buffer)
    if (!transcript) { await ctx.api.editMessageText(ctx.chat.id, status.message_id, "❌ Transcription failed.").catch(() => {}); return }
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `💬 ${transcript}`).catch(() => {})
    await startStreamingReply({ opencode, ctx, userId, userText: transcript, parts: [{ type: "text", text: transcript }], contextKey, messageThreadId })
  } catch (err) { console.error("Voice failed:", err); await ctx.api.editMessageText(ctx.chat.id, status.message_id, "❌ Transcription failed.").catch(() => {}) }
})

bot.on("message:audio", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const audio = ctx.message.audio; if (!audio) return
  if (audio.file_size && audio.file_size > constants.MAX_ATTACHMENT_BYTES) { await ctx.reply("Audio too large.", withThreadId({}, messageThreadId)); return }
  if (!OPENAI_API_KEY) { await ctx.reply("Audio transcription requires OPENAI_API_KEY.", withThreadId({}, messageThreadId)); return }
  const status = await ctx.reply("🎤 Transcribing audio...", withThreadId({}, messageThreadId))
  try {
    const buffer = await fetchTelegramFile(ctx.api, audio.file_id)
    const transcript = await transcribeVoice(buffer)
    if (!transcript) { await ctx.api.editMessageText(ctx.chat.id, status.message_id, "❌ Transcription failed.").catch(() => {}); return }
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `💬 ${transcript}`).catch(() => {})
    await startStreamingReply({ opencode, ctx, userId, userText: transcript, parts: [{ type: "text", text: transcript }], contextKey, messageThreadId })
  } catch (err) { console.error("Audio failed:", err); await ctx.api.editMessageText(ctx.chat.id, status.message_id, "❌ Transcription failed.").catch(() => {}) }
})

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id; if (!userId) return
  const messageThreadId = getMessageThreadId(ctx)
  const contextKey = getSessionKey(ctx.chat, userId, messageThreadId)
  const pending = pendingApiAuth.get(userId)
  if (pending && !ctx.message.text.startsWith("/")) {
    pendingApiAuth.delete(userId)
    const key = ctx.message.text.trim(); if (!key) { await ctx.reply("Empty key.", withThreadId({}, messageThreadId)); return }
    await ctx.deleteMessage().catch(() => {})
    try { await opencode.auth.set({ path: { id: pending.providerId }, body: { type: "api", key } }); await ctx.reply(`✅ API key saved for ${pending.providerId}.`, withThreadId({}, messageThreadId)) }
    catch { await ctx.reply("Failed.", withThreadId({}, messageThreadId)) }
    return
  }
  if (ctx.message.text.startsWith("/")) return
  if (ctx.message.text.startsWith("!")) {
    if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(userId)) {
      await ctx.reply("⛔ Shell access denied.", withThreadId({}, messageThreadId))
      return
    }
    const command = ctx.message.text.slice(1).trim()
    if (!command) { await ctx.reply("Usage: !<command>", withThreadId({}, messageThreadId)); return }
    const settings = db.loadUserSettings(userId) ?? {}
    const currentSessionId = chatSessions.get(contextKey)
    const cwd = getSessionDirectoryHint(currentSessionId) ?? settings.defaultDirectory ?? process.cwd()
    const result = await shell.executeCommand(command, cwd, settings.allowedRoots)
    const formatted = shell.formatShellResult(command, result)
    const chunks = utils.splitRawMarkdown(formatted)
    for (const chunk of chunks) {
      await ctx.reply(utils.toTelegramMarkdown(chunk), withThreadId({ parse_mode: constants.TELEGRAM_PARSE_MODE }, messageThreadId)).catch(() => ctx.reply(chunk, withThreadId({}, messageThreadId)))
    }
    return
  }
  const currentSessionId = chatSessions.get(contextKey)
  const activeEntry = currentSessionId ? [...activeMessages.values()].find(e => e.sessionId === currentSessionId && !e.state.aborted) : null
  if (activeEntry) {
    const nudgeText = ctx.message.text.trim(); if (!nudgeText) return
    if (activeEntry.state.pendingPermission) { const queue = pendingNudges.get(activeEntry.sessionId) ?? []; queue.push(nudgeText); pendingNudges.set(activeEntry.sessionId, queue); return }
    await opencode.session.promptAsync({ path: { id: activeEntry.sessionId }, ...withSessionDirectory(activeEntry.sessionId), body: { noReply: true, parts: [{ type: "text", text: nudgeText }] } }).catch(() => {})
    return
  }
  await startStreamingReply({ opencode, ctx, userId, userText: ctx.message.text, parts: [{ type: "text", text: ctx.message.text }], contextKey, messageThreadId })
})

console.log("Starting Telegram bot...")
bot.start()
console.log("Bot running!")
