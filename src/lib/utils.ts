import * as path from "node:path"
import telegramifyMarkdown from "telegramify-markdown"
import { RAW_MARKDOWN_SAFE_LIMIT, SESSION_DIVIDER_LINE, MAX_DIR_LABEL } from "./constants.js"

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 3))}...`
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function getDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export function formatTime(date = new Date()): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  if (days < 7) return `${days}d`
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export function formatShortPath(dir: string, max = MAX_DIR_LABEL): string {
  const normalized = dir.replace(/\\/g, "/")
  if (normalized === "/") return "/"
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length === 0) return "/"
  const tail = parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/")
  const display = parts.length > 2 ? `…/${tail}` : `/${tail}`
  if (display.length <= max) return display
  return `…${display.slice(display.length - (max - 1))}`
}

export function formatDirName(dir: string): string {
  const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "")
  if (normalized === "" || normalized === "/") return "/"
  const parts = normalized.split("/")
  return parts[parts.length - 1] || "/"
}

export function cleanSessionTitle(title: string): string {
  const cleaned = title.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "").trim()
  const tidied = cleaned.replace(/\s*-\s*$/, "").replace(/^\s*-\s*/, "").trim()
  return tidied || "Untitled"
}

export function formatSessionDivider(label: string): string {
  return `${SESSION_DIVIDER_LINE}\n${label}\n${SESSION_DIVIDER_LINE}`
}

export function toTelegramMarkdown(text: string): string {
  return telegramifyMarkdown(text ?? "", "escape")
}

export function clampRawMarkdown(text: string): { text: string; truncated: boolean } {
  if (text.length <= RAW_MARKDOWN_SAFE_LIMIT) return { text, truncated: false }
  let cut = text.lastIndexOf("\n\n", RAW_MARKDOWN_SAFE_LIMIT)
  if (cut < RAW_MARKDOWN_SAFE_LIMIT / 2) cut = text.lastIndexOf("\n", RAW_MARKDOWN_SAFE_LIMIT)
  if (cut < RAW_MARKDOWN_SAFE_LIMIT / 2) cut = text.lastIndexOf(" ", RAW_MARKDOWN_SAFE_LIMIT)
  if (cut < RAW_MARKDOWN_SAFE_LIMIT / 2) cut = RAW_MARKDOWN_SAFE_LIMIT
  
  const prefix = text.slice(0, cut)
  const fenceCount = (prefix.match(/```/g) ?? []).length
  if (fenceCount % 2 === 1) {
    const lastFence = prefix.lastIndexOf("```")
    if (lastFence > 0) cut = lastFence
  }
  
  return { text: text.slice(0, cut).trimEnd() + "...", truncated: true }
}

export function splitRawMarkdown(text: string, max = RAW_MARKDOWN_SAFE_LIMIT): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      chunks.push(remaining)
      break
    }
    let cut = remaining.lastIndexOf("\n\n", max)
    if (cut < max / 2) cut = remaining.lastIndexOf("\n", max)
    if (cut < max / 2) cut = remaining.lastIndexOf(" ", max)
    if (cut < max / 2) cut = max

    const prefix = remaining.slice(0, cut)
    const fenceCount = (prefix.match(/```/g) ?? []).length
    if (fenceCount % 2 === 1) {
      const lastFence = prefix.lastIndexOf("```")
      if (lastFence > 0) cut = lastFence
    }

    const chunk = remaining.slice(0, cut).trimEnd()
    if (chunk.length === 0) cut = max

    chunks.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  return chunks
}

export function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/retry after (\d+)/i)
  if (!match) return null
  const seconds = Number(match[1])
  return Number.isFinite(seconds) ? seconds : null
}

export function isTelegramParseError(message: string): boolean {
  return message.includes("can't parse entities") || message.includes("parse entities")
}

export function parseCommandArgs(text: string): string[] {
  const args: string[] = []
  let current = ""
  let inQuotes = false
  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

export function messageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`
}

export function parseMessageKey(key: string): { chatId: number; messageId: number } | null {
  const [chatIdRaw, messageIdRaw] = key.split(":")
  if (!chatIdRaw || !messageIdRaw) return null
  const chatId = Number(chatIdRaw)
  const messageId = Number(messageIdRaw)
  if (Number.isNaN(chatId) || Number.isNaN(messageId)) return null
  return { chatId, messageId }
}

export function resolveDirectoryInput(input: string, baseDir: string): string {
  if (input === "~") {
    return process.env.HOME ? process.env.HOME : baseDir
  }
  if (input.startsWith("~/")) {
    const home = process.env.HOME
    if (home) return path.join(home, input.slice(2))
  }
  if (path.isAbsolute(input)) return input
  return path.resolve(baseDir, input)
}

export function formatCodeBlockMarkdown(text: string, maxChars = 3500): string {
  const trimmed = text.length > maxChars ? `${text.slice(0, maxChars - 16)}\n... (truncated)` : text
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/`/g, "\\`")
  return `\`\`\`\n${escaped}\n\`\`\``
}

export function getHomeDirectory(): string {
  return process.env.HOME ?? process.cwd()
}

export function formatMessageError(error: unknown): string {
  if (!error) return "Unknown error."
  const maybeMessage = (error as { data?: { message?: string } }).data?.message
  if (maybeMessage) return maybeMessage
  return "Request failed."
}
