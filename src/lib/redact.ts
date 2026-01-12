const SECRET_PATTERNS = [
  /\b(sk-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(sk-proj-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(pk-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
  /\b(gho_[a-zA-Z0-9]{36,})\b/g,
  /\b(github_pat_[a-zA-Z0-9_]{22,})\b/g,
  /\b(xox[baprs]-[a-zA-Z0-9-]+)\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b([a-f0-9]{32,64})\b/g,
  /(['"]?(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token|access[_-]?token|bearer|password|passwd|pwd)['"]?\s*[:=]\s*['"]?)([^'"\s]{8,})(['"]?)/gi,
  /\b(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/g,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
  /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}@[^\s]+)\b/g,
]

const ENV_LINE_PATTERN = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/gm

export function redactSecrets(text: string): string {
  let result = text

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, ...groups) => {
      if (groups.length >= 3 && typeof groups[1] === "string") {
        const prefix = groups[0] || ""
        const secret = groups[1]
        const suffix = groups[2] || ""
        return `${prefix}[REDACTED:${secret.length}chars]${suffix}`
      }
      if (typeof match === "string" && match.length > 12) {
        return `[REDACTED:${match.length}chars]`
      }
      return match
    })
  }

  result = result.replace(ENV_LINE_PATTERN, (match, key, value) => {
    const sensitiveKeys = ["KEY", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL", "AUTH", "PRIVATE"]
    if (sensitiveKeys.some(s => key.toUpperCase().includes(s))) {
      return `${key}=[REDACTED:${value.length}chars]`
    }
    return match
  })

  return result
}

export function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

export function redactForDisplay(text: string, enabled: boolean): string {
  return enabled ? redactSecrets(text) : text
}
