import type { Permission } from "@opencode-ai/sdk"
import type { PermissionProfile } from "./types.js"
import { loadPermissionOverrides } from "./db.js"

const STRICT_AUTO_ALLOW = new Set<string>([])

const BALANCED_AUTO_ALLOW = new Set([
  "read",
  "glob",
  "grep",
  "todoread",
  "webfetch",
])

const POWER_AUTO_ALLOW = new Set([
  "read",
  "glob",
  "grep",
  "todoread",
  "webfetch",
  "edit",
  "write",
  "bash",
  "task",
])

export function getAutoAllowSet(profile: PermissionProfile): Set<string> {
  switch (profile) {
    case "strict":
      return STRICT_AUTO_ALLOW
    case "power":
      return POWER_AUTO_ALLOW
    default:
      return BALANCED_AUTO_ALLOW
  }
}

export function shouldAutoAllow(
  permission: Permission,
  profile: PermissionProfile,
  userId?: number
): boolean {
  const overrides = userId ? loadPermissionOverrides(userId) : []
  
  for (const override of overrides) {
    if (override.tool === permission.type || override.tool === "*") {
      if (override.action === "allow") return true
      if (override.action === "deny") return false
    }
  }
  
  const autoAllowSet = getAutoAllowSet(profile)
  return autoAllowSet.has(permission.type)
}

export function getProfileDescription(profile: PermissionProfile): string {
  switch (profile) {
    case "strict":
      return "Ask for every action"
    case "balanced":
      return "Auto-allow reads, ask for writes"
    case "power":
      return "Auto-allow most, ask for destructive"
  }
}

export function getNextProfile(current: PermissionProfile): PermissionProfile {
  switch (current) {
    case "strict":
      return "balanced"
    case "balanced":
      return "power"
    case "power":
      return "strict"
  }
}
