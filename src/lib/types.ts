import type { Permission, Todo } from "@opencode-ai/sdk"

export type PermissionProfile = "strict" | "balanced" | "power"
export type ScopeMode = "user" | "thread" | "shared"
export type AgentMode = "plan" | "build"
export type ExportFormat = "markdown" | "json" | "html"

export interface ModelSelection {
  providerID: string
  modelID: string
}

export interface UserSettings {
  model?: ModelSelection
  agentMode?: AgentMode
  permissionProfile?: PermissionProfile
  defaultDirectory?: string
  allowedRoots?: string[]
  scopeMode?: ScopeMode
  secretRedaction?: boolean
}

export interface ToolState {
  name: string
  title: string
  status: string
}

export interface DisplayState {
  phase: "thinking" | "reasoning" | "tools" | "responding" | "permission"
  userInput: string
  reasoning: string
  tools: Map<string, ToolState>
  toolHistory: string[]
  currentTool: string | null
  text: string
  statusNote: string | null
  filesEdited: string[]
  todos: Todo[]
  tokens: { input: number; output: number }
  cost: number
  modelLabel: string | null
  pendingPermission: Permission | null
  aborted: boolean
}

export interface ActiveMessage {
  userId: number
  sessionId: string
  state: DisplayState
  resolvePermission?: () => void
  abortController: AbortController
}

export interface MenuState {
  userId: number
  page: number
  sessionIds: string[]
  showAllSessions?: boolean
}

export interface ModelMenuState {
  userId: number
  view: "providers" | "models"
  providers: ProviderSummary[]
  providerPage: number
  modelPage: number
  providerId?: string
  defaults?: DefaultModels
}

export interface ModeMenuState {
  userId: number
}

export interface ProviderSummary {
  id: string
  name: string
  models: ModelSummary[]
}

export interface ModelSummary {
  id: string
  name: string
  attachment: boolean
  reasoning: boolean
  tool_call: boolean
  status?: string
}

export type DefaultModels = Record<string, string>

export interface RecentModel {
  providerID: string
  modelID: string
  label: string
  timestamp: number
}

export interface DirectoryListingEntry {
  label: string
  path: string
}

export interface DirectoryBrowseState {
  baseDir: string
  page: number
  totalPages: number
  totalDirs: number
  entries: DirectoryListingEntry[]
  recents: string[]
  error?: string | null
}

export interface UsageBucket {
  tokens: number
  cost: number
  messages: number
}

export interface UsageStats {
  totalTokens: number
  totalCost: number
  totalMessages: number
  daily: Map<string, UsageBucket>
  byModel: Map<string, UsageBucket>
}

export interface PendingAuth {
  providerId: string
  methodIndex: number
  type: "oauth" | "api"
}

export interface PendingGitCommand {
  userId: number
  args: string[]
  createdAt: number
}

export interface UndoEntry {
  id: string
  type: "file" | "git" | "permission"
  timestamp: number
  description: string
  data: Record<string, unknown>
}

export interface TaskWorkflow {
  id: string
  name: string
  icon: string
  description: string
  prompt: string
  mode?: AgentMode
  directory?: string
}

export interface HistoryEntry {
  id: string
  sessionId: string
  role: "user" | "assistant"
  timestamp: number
  text: string
  toolNames?: string[]
}

export interface ScopeKey {
  chatId: number
  threadId?: number
  userId?: number
  mode: ScopeMode
}

export interface ExportOptions {
  format: ExportFormat
  includeToolOutputs?: boolean
  redactSecrets?: boolean
  startTime?: number
  endTime?: number
}

export interface BranchCache {
  value: string
  updatedAt: number
}
