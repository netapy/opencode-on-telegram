import { Database } from "bun:sqlite"
import type {
  UserSettings,
  UsageStats,
  UndoEntry,
  HistoryEntry,
  PermissionProfile,
  ScopeMode,
  AgentMode,
} from "./types.js"

const DB_PATH = process.env.OPENCODE_DB_PATH ?? "./opencode-telegram.db"

let db: Database | null = null

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH)
    db.exec("PRAGMA journal_mode = WAL")
    initSchema()
  }
  return db
}

function initSchema(): void {
  const d = getDb()
  d.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      model_provider TEXT,
      model_id TEXT,
      agent_mode TEXT DEFAULT 'build',
      permission_profile TEXT DEFAULT 'balanced',
      default_directory TEXT,
      allowed_roots TEXT,
      scope_mode TEXT DEFAULT 'user',
      secret_redaction INTEGER DEFAULT 1
    );
    
    CREATE TABLE IF NOT EXISTS chat_sessions (
      context_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    
    CREATE TABLE IF NOT EXISTS session_directories (
      session_id TEXT PRIMARY KEY,
      directory TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS session_titles (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS recent_directories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_key TEXT NOT NULL,
      directory TEXT NOT NULL,
      used_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(context_key, directory)
    );
    
    CREATE TABLE IF NOT EXISTS recent_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      label TEXT NOT NULL,
      used_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(user_id, provider_id, model_id)
    );
    
    CREATE TABLE IF NOT EXISTS usage_stats (
      user_id INTEGER NOT NULL,
      date_key TEXT NOT NULL,
      model_label TEXT,
      tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      messages INTEGER DEFAULT 0,
      PRIMARY KEY(user_id, date_key, model_label)
    );
    
    CREATE TABLE IF NOT EXISTS undo_stack (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      description TEXT NOT NULL,
      data TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      text TEXT NOT NULL,
      tool_names TEXT
    );
    
    CREATE TABLE IF NOT EXISTS permission_overrides (
      user_id INTEGER NOT NULL,
      tool TEXT NOT NULL,
      pattern TEXT,
      action TEXT NOT NULL,
      PRIMARY KEY(user_id, tool, pattern)
    );

    CREATE INDEX IF NOT EXISTS idx_history_session ON history(session_id);
    CREATE INDEX IF NOT EXISTS idx_history_text ON history(text);
    CREATE INDEX IF NOT EXISTS idx_undo_user ON undo_stack(user_id, timestamp DESC);
  `)
}

export function saveUserSettings(userId: number, settings: UserSettings): void {
  const d = getDb()
  d.run(`
    INSERT OR REPLACE INTO user_settings 
    (user_id, model_provider, model_id, agent_mode, permission_profile, default_directory, allowed_roots, scope_mode, secret_redaction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      userId,
      settings.model?.providerID ?? null,
      settings.model?.modelID ?? null,
      settings.agentMode ?? "build",
      settings.permissionProfile ?? "balanced",
      settings.defaultDirectory ?? null,
      settings.allowedRoots ? JSON.stringify(settings.allowedRoots) : null,
      settings.scopeMode ?? "user",
      settings.secretRedaction === false ? 0 : 1,
    ]
  )
}

export function loadUserSettings(userId: number): UserSettings | null {
  const d = getDb()
  const row = d.query(`SELECT * FROM user_settings WHERE user_id = ?`).get(userId) as Record<string, unknown> | null
  if (!row) return null
  return {
    model: row.model_provider && row.model_id
      ? { providerID: row.model_provider as string, modelID: row.model_id as string }
      : undefined,
    agentMode: (row.agent_mode as AgentMode) ?? "build",
    permissionProfile: (row.permission_profile as PermissionProfile) ?? "balanced",
    defaultDirectory: row.default_directory as string | undefined,
    allowedRoots: row.allowed_roots ? JSON.parse(row.allowed_roots as string) : undefined,
    scopeMode: (row.scope_mode as ScopeMode) ?? "user",
    secretRedaction: row.secret_redaction !== 0,
  }
}

export function saveChatSession(contextKey: string, sessionId: string): void {
  const d = getDb()
  d.run(`INSERT OR REPLACE INTO chat_sessions (context_key, session_id, updated_at) VALUES (?, ?, ?)`,
    [contextKey, sessionId, Date.now()])
}

export function loadChatSession(contextKey: string): string | null {
  const d = getDb()
  const row = d.query(`SELECT session_id FROM chat_sessions WHERE context_key = ?`).get(contextKey) as { session_id: string } | null
  return row?.session_id ?? null
}

export function saveSessionDirectory(sessionId: string, directory: string): void {
  const d = getDb()
  d.run(`INSERT OR REPLACE INTO session_directories (session_id, directory) VALUES (?, ?)`, [sessionId, directory])
}

export function loadSessionDirectory(sessionId: string): string | null {
  const d = getDb()
  const row = d.query(`SELECT directory FROM session_directories WHERE session_id = ?`).get(sessionId) as { directory: string } | null
  return row?.directory ?? null
}

export function saveSessionTitle(sessionId: string, title: string): void {
  const d = getDb()
  d.run(`INSERT OR REPLACE INTO session_titles (session_id, title) VALUES (?, ?)`, [sessionId, title])
}

export function loadSessionTitle(sessionId: string): string | null {
  const d = getDb()
  const row = d.query(`SELECT title FROM session_titles WHERE session_id = ?`).get(sessionId) as { title: string } | null
  return row?.title ?? null
}

export function saveRecentDirectory(contextKey: string, directory: string): void {
  const d = getDb()
  d.run(`INSERT OR REPLACE INTO recent_directories (context_key, directory, used_at) VALUES (?, ?, ?)`,
    [contextKey, directory, Date.now()])
  d.run(`DELETE FROM recent_directories WHERE context_key = ? AND id NOT IN (
    SELECT id FROM recent_directories WHERE context_key = ? ORDER BY used_at DESC LIMIT 6
  )`, [contextKey, contextKey])
}

export function loadRecentDirectories(contextKey: string): string[] {
  const d = getDb()
  const rows = d.query(`SELECT directory FROM recent_directories WHERE context_key = ? ORDER BY used_at DESC LIMIT 6`)
    .all(contextKey) as { directory: string }[]
  return rows.map(r => r.directory)
}

export function saveRecentModel(userId: number, providerID: string, modelID: string, label: string): void {
  const d = getDb()
  d.run(`INSERT OR REPLACE INTO recent_models (user_id, provider_id, model_id, label, used_at) VALUES (?, ?, ?, ?, ?)`,
    [userId, providerID, modelID, label, Date.now()])
  d.run(`DELETE FROM recent_models WHERE user_id = ? AND id NOT IN (
    SELECT id FROM recent_models WHERE user_id = ? ORDER BY used_at DESC LIMIT 3
  )`, [userId, userId])
}

export function loadRecentModels(userId: number): Array<{ providerID: string; modelID: string; label: string; timestamp: number }> {
  const d = getDb()
  const rows = d.query(`SELECT provider_id, model_id, label, used_at FROM recent_models WHERE user_id = ? ORDER BY used_at DESC LIMIT 3`)
    .all(userId) as Array<{ provider_id: string; model_id: string; label: string; used_at: number }>
  return rows.map(r => ({
    providerID: r.provider_id,
    modelID: r.model_id,
    label: r.label,
    timestamp: r.used_at,
  }))
}

export function recordUsage(userId: number, modelLabel: string | null, dateKey: string, tokens: number, cost: number, messages: number): void {
  const d = getDb()
  d.run(`
    INSERT INTO usage_stats (user_id, date_key, model_label, tokens, cost, messages)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date_key, model_label) DO UPDATE SET
      tokens = tokens + excluded.tokens,
      cost = cost + excluded.cost,
      messages = messages + excluded.messages
  `, [userId, dateKey, modelLabel ?? "default", tokens, cost, messages])
}

export function loadUsageStats(userId: number): UsageStats {
  const d = getDb()
  const rows = d.query(`SELECT date_key, model_label, tokens, cost, messages FROM usage_stats WHERE user_id = ?`)
    .all(userId) as Array<{ date_key: string; model_label: string; tokens: number; cost: number; messages: number }>
  
  const stats: UsageStats = {
    totalTokens: 0,
    totalCost: 0,
    totalMessages: 0,
    daily: new Map(),
    byModel: new Map(),
  }
  
  for (const row of rows) {
    stats.totalTokens += row.tokens
    stats.totalCost += row.cost
    stats.totalMessages += row.messages
    
    const dailyBucket = stats.daily.get(row.date_key) ?? { tokens: 0, cost: 0, messages: 0 }
    dailyBucket.tokens += row.tokens
    dailyBucket.cost += row.cost
    dailyBucket.messages += row.messages
    stats.daily.set(row.date_key, dailyBucket)
    
    const modelBucket = stats.byModel.get(row.model_label) ?? { tokens: 0, cost: 0, messages: 0 }
    modelBucket.tokens += row.tokens
    modelBucket.cost += row.cost
    modelBucket.messages += row.messages
    stats.byModel.set(row.model_label, modelBucket)
  }
  
  return stats
}

export function pushUndo(userId: number, entry: UndoEntry): void {
  const d = getDb()
  d.run(`INSERT INTO undo_stack (id, user_id, type, timestamp, description, data) VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.id, userId, entry.type, entry.timestamp, entry.description, JSON.stringify(entry.data)])
  d.run(`DELETE FROM undo_stack WHERE user_id = ? AND id NOT IN (
    SELECT id FROM undo_stack WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20
  )`, [userId, userId])
}

export function popUndo(userId: number): UndoEntry | null {
  const d = getDb()
  const row = d.query(`SELECT * FROM undo_stack WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`)
    .get(userId) as { id: string; type: string; timestamp: number; description: string; data: string } | null
  if (!row) return null
  d.run(`DELETE FROM undo_stack WHERE id = ?`, [row.id])
  return {
    id: row.id,
    type: row.type as "file" | "git" | "permission",
    timestamp: row.timestamp,
    description: row.description,
    data: JSON.parse(row.data),
  }
}

export function getUndoStack(userId: number, limit = 5): UndoEntry[] {
  const d = getDb()
  const rows = d.query(`SELECT * FROM undo_stack WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?`)
    .all(userId, limit) as Array<{ id: string; type: string; timestamp: number; description: string; data: string }>
  return rows.map(row => ({
    id: row.id,
    type: row.type as "file" | "git" | "permission",
    timestamp: row.timestamp,
    description: row.description,
    data: JSON.parse(row.data),
  }))
}

export function saveHistoryEntry(entry: HistoryEntry): void {
  const d = getDb()
  d.run(`INSERT OR REPLACE INTO history (id, session_id, role, timestamp, text, tool_names) VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.sessionId, entry.role, entry.timestamp, entry.text, entry.toolNames?.join(",") ?? null])
}

export function searchHistory(sessionId: string, query: string, limit = 20): HistoryEntry[] {
  const d = getDb()
  const rows = d.query(`
    SELECT * FROM history 
    WHERE session_id = ? AND text LIKE ? 
    ORDER BY timestamp DESC LIMIT ?
  `).all(sessionId, `%${query}%`, limit) as Array<{
    id: string; session_id: string; role: string; timestamp: number; text: string; tool_names: string | null
  }>
  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role as "user" | "assistant",
    timestamp: row.timestamp,
    text: row.text,
    toolNames: row.tool_names?.split(",").filter(Boolean),
  }))
}

export function getSessionHistory(sessionId: string, limit = 50, offset = 0): HistoryEntry[] {
  const d = getDb()
  const rows = d.query(`
    SELECT * FROM history WHERE session_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?
  `).all(sessionId, limit, offset) as Array<{
    id: string; session_id: string; role: string; timestamp: number; text: string; tool_names: string | null
  }>
  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role as "user" | "assistant",
    timestamp: row.timestamp,
    text: row.text,
    toolNames: row.tool_names?.split(",").filter(Boolean),
  }))
}

export function savePermissionOverride(userId: number, tool: string, pattern: string | null, action: "allow" | "deny" | "ask"): void {
  const d = getDb()
  d.run(`INSERT OR REPLACE INTO permission_overrides (user_id, tool, pattern, action) VALUES (?, ?, ?, ?)`,
    [userId, tool, pattern ?? "*", action])
}

export function loadPermissionOverrides(userId: number): Array<{ tool: string; pattern: string; action: string }> {
  const d = getDb()
  const rows = d.query(`SELECT tool, pattern, action FROM permission_overrides WHERE user_id = ?`)
    .all(userId) as Array<{ tool: string; pattern: string; action: string }>
  return rows
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
