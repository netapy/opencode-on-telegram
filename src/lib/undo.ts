import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { UndoEntry } from "./types.js"
import { pushUndo, popUndo, getUndoStack } from "./db.js"

export async function captureFileState(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    return content
  } catch {
    return null
  }
}

export async function createFileUndoEntry(
  userId: number,
  filePath: string,
  operation: "edit" | "write" | "delete"
): Promise<void> {
  const previousContent = await captureFileState(filePath)
  const exists = previousContent !== null
  
  const entry: UndoEntry = {
    id: crypto.randomUUID(),
    type: "file",
    timestamp: Date.now(),
    description: `${operation} ${path.basename(filePath)}`,
    data: {
      path: filePath,
      operation,
      previousContent,
      existed: exists,
    },
  }
  
  pushUndo(userId, entry)
}

export async function createGitUndoEntry(
  userId: number,
  command: string,
  previousHead: string
): Promise<void> {
  const entry: UndoEntry = {
    id: crypto.randomUUID(),
    type: "git",
    timestamp: Date.now(),
    description: `git ${command}`,
    data: {
      command,
      previousHead,
    },
  }
  
  pushUndo(userId, entry)
}

export async function executeUndo(entry: UndoEntry): Promise<{ success: boolean; message: string }> {
  switch (entry.type) {
    case "file":
      return executeFileUndo(entry)
    case "git":
      return executeGitUndo(entry)
    default:
      return { success: false, message: "Unknown undo type" }
  }
}

async function executeFileUndo(entry: UndoEntry): Promise<{ success: boolean; message: string }> {
  const { path: filePath, previousContent, existed, operation } = entry.data as {
    path: string
    previousContent: string | null
    existed: boolean
    operation: string
  }
  
  try {
    if (!existed) {
      await fs.unlink(filePath).catch(() => {})
      return { success: true, message: `Deleted ${path.basename(filePath)}` }
    }
    
    if (previousContent !== null) {
      await fs.writeFile(filePath, previousContent, "utf-8")
      return { success: true, message: `Restored ${path.basename(filePath)}` }
    }
    
    return { success: false, message: "No previous content to restore" }
  } catch (err) {
    return { success: false, message: `Undo failed: ${err}` }
  }
}

async function executeGitUndo(entry: UndoEntry): Promise<{ success: boolean; message: string }> {
  const { previousHead } = entry.data as { previousHead: string }
  
  try {
    const proc = Bun.spawn({
      cmd: ["git", "reset", "--keep", previousHead],
      stdout: "pipe",
      stderr: "pipe",
    })
    const code = await proc.exited
    
    if (code === 0) {
      return { success: true, message: `Reset to ${previousHead.slice(0, 8)}` }
    }
    
    const stderr = await new Response(proc.stderr).text()
    return { success: false, message: `Git reset failed: ${stderr}` }
  } catch (err) {
    return { success: false, message: `Undo failed: ${err}` }
  }
}

export function getRecentUndos(userId: number): UndoEntry[] {
  return getUndoStack(userId, 5)
}

export async function undoLast(userId: number): Promise<{ success: boolean; message: string }> {
  const entry = popUndo(userId)
  if (!entry) {
    return { success: false, message: "Nothing to undo" }
  }
  return executeUndo(entry)
}

export function formatUndoEntry(entry: UndoEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString()
  const icon = entry.type === "file" ? "📄" : entry.type === "git" ? "🔀" : "🔐"
  return `${icon} ${entry.description} (${time})`
}
