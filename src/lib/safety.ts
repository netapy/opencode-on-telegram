import * as path from "node:path"
import type { Permission } from "@opencode-ai/sdk"

export interface SafetyCheck {
  allowed: boolean
  reason?: string
}

export function checkPathSafety(
  targetPath: string,
  allowedRoots: string[] | undefined
): SafetyCheck {
  if (!allowedRoots || allowedRoots.length === 0) {
    return { allowed: true }
  }
  
  const normalizedTarget = path.resolve(targetPath)
  
  for (const root of allowedRoots) {
    const normalizedRoot = path.resolve(root)
    if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)) {
      return { allowed: true }
    }
  }
  
  return {
    allowed: false,
    reason: `Path "${targetPath}" is outside allowed directories`,
  }
}

export function extractPathFromPermission(permission: Permission): string | null {
  const metadata = permission.metadata as Record<string, unknown>
  
  const pathFields = ["path", "file", "filePath", "target", "directory", "cwd"]
  for (const field of pathFields) {
    const value = metadata[field]
    if (typeof value === "string" && value.length > 0) {
      return value
    }
  }
  
  const command = metadata.command as string | undefined
  const args = metadata.args as string[] | undefined
  if (command && args) {
    for (const arg of args) {
      if (arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../")) {
        return arg
      }
    }
  }
  
  return null
}

export function checkPermissionSafety(
  permission: Permission,
  allowedRoots: string[] | undefined
): SafetyCheck {
  const targetPath = extractPathFromPermission(permission)
  
  if (!targetPath) {
    return { allowed: true }
  }
  
  return checkPathSafety(targetPath, allowedRoots)
}

const DANGEROUS_COMMANDS = new Set([
  "rm -rf /",
  "rm -rf ~",
  "rm -rf /*",
  "mkfs",
  "> /dev/sda",
  "dd if=/dev/zero",
  ":(){:|:&};:",
])

export function checkCommandSafety(command: string): SafetyCheck {
  const normalized = command.toLowerCase().trim()
  
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (normalized.includes(dangerous)) {
      return {
        allowed: false,
        reason: `Dangerous command pattern detected: "${dangerous}"`,
      }
    }
  }
  
  return { allowed: true }
}

export function formatSafetyWarning(check: SafetyCheck): string {
  if (check.allowed) return ""
  return `⚠️ Safety Warning: ${check.reason}`
}
