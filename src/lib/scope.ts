import type { ScopeMode, ScopeKey } from "./types.js"

export function buildScopeKey(params: {
  chatId: number
  chatType: string
  threadId?: number
  userId?: number
  mode: ScopeMode
}): string {
  const { chatId, chatType, threadId, userId, mode } = params
  
  if (chatType === "private") {
    return threadId ? `${chatId}:${threadId}` : `${chatId}`
  }
  
  switch (mode) {
    case "user":
      return userId ? `${chatId}:user:${userId}` : `${chatId}`
    case "thread":
      return threadId ? `${chatId}:thread:${threadId}` : `${chatId}`
    case "shared":
    default:
      return `${chatId}`
  }
}

export function parseScopeKey(key: string): ScopeKey | null {
  const parts = key.split(":")
  
  if (parts.length === 1) {
    const chatId = Number(parts[0])
    if (Number.isNaN(chatId)) return null
    return { chatId, mode: "shared" }
  }
  
  if (parts.length === 2) {
    const chatId = Number(parts[0])
    const second = Number(parts[1])
    if (Number.isNaN(chatId) || Number.isNaN(second)) return null
    return { chatId, threadId: second, mode: "thread" }
  }
  
  if (parts.length === 3) {
    const chatId = Number(parts[0])
    const scopeType = parts[1]
    const scopeId = Number(parts[2])
    
    if (Number.isNaN(chatId) || Number.isNaN(scopeId)) return null
    
    if (scopeType === "user") {
      return { chatId, userId: scopeId, mode: "user" }
    }
    if (scopeType === "thread") {
      return { chatId, threadId: scopeId, mode: "thread" }
    }
  }
  
  return null
}

export function getScopeModeDescription(mode: ScopeMode): string {
  switch (mode) {
    case "user":
      return "Isolated per user"
    case "thread":
      return "Shared per topic/thread"
    case "shared":
      return "Shared with everyone"
  }
}

export function getNextScopeMode(current: ScopeMode): ScopeMode {
  switch (current) {
    case "user":
      return "thread"
    case "thread":
      return "shared"
    case "shared":
      return "user"
  }
}

export function formatScopeIndicator(mode: ScopeMode): string {
  switch (mode) {
    case "user":
      return "👤 Private"
    case "thread":
      return "💬 Thread"
    case "shared":
      return "👥 Shared"
  }
}
