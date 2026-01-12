import * as path from "node:path"

export interface ShellResult {
  success: boolean
  stdout: string
  stderr: string
  code: number
  blocked?: boolean
  reason?: string
}

const BLOCKED_COMMANDS = new Set([
  "sudo",
  "su",
  "passwd",
  "chsh",
  "chroot",
  "reboot",
  "shutdown",
  "poweroff",
  "halt",
  "init",
  "systemctl",
  "service",
  "kill",
  "killall",
  "pkill",
  "curl",
  "wget",
  "nc",
  "netcat",
  "telnet",
  "ssh",
  "scp",
  "rsync",
  "ftp",
  "sftp",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "brew",
  "pip",
  "pip3",
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "cargo",
  "go",
  "gem",
  "composer",
  "chmod",
  "chown",
  "chgrp",
  "setfacl",
  "mkfs",
  "fdisk",
  "parted",
  "mount",
  "umount",
  "dd",
  "format",
  "crontab",
  "at",
  "nohup",
  "screen",
  "tmux",
  "eval",
  "exec",
  "source",
  "export",
  "unset",
  "alias",
])

const BLOCKED_PATTERNS = [
  /rm\s+(-[a-z]*)?.*\s+(-rf|-fr|--force|--recursive)/i,
  /rm\s+(-rf|-fr)\s*/i,
  />\s*\/dev\/(sda|sdb|nvme|hd)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\/dev\/null/i,
  />\s*\/etc\//i,
  />\s*\/boot\//i,
  />\s*\/bin\//i,
  />\s*\/sbin\//i,
  />\s*\/usr\//i,
  />\s*\/lib\//i,
  /\$\([^)]+\)/,
  /`[^`]+`/,
  /\bhistory\b.*(-c|-d|--clear)/i,
]

const SHELL_OPERATORS = ["&&", "||", ";", "|", ">", ">>", "<", "<<", "&", "$(", "`"]

const MAX_STDOUT = 2000
const MAX_STDERR = 1000
const TIMEOUT_MS = 30000

export function parseCommand(input: string): { command: string; args: string[] } | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const parts = trimmed.split(/\s+/)
  const command = parts[0]
  const args = parts.slice(1)

  return { command, args }
}

export function validateCommand(input: string): { allowed: boolean; reason?: string } {
  const trimmed = input.trim().toLowerCase()

  for (const op of SHELL_OPERATORS) {
    if (input.includes(op)) {
      return { allowed: false, reason: `Shell operator "${op}" not allowed` }
    }
  }

  const parsed = parseCommand(input)
  if (!parsed) {
    return { allowed: false, reason: "Empty command" }
  }

  const baseCommand = path.basename(parsed.command)
  if (BLOCKED_COMMANDS.has(baseCommand)) {
    return { allowed: false, reason: `Command "${baseCommand}" is blocked` }
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(input)) {
      return { allowed: false, reason: "Dangerous command pattern detected" }
    }
  }

  return { allowed: true }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 20) + "\n... (truncated)"
}

export async function executeCommand(
  input: string,
  cwd: string,
  allowedRoots?: string[]
): Promise<ShellResult> {
  const validation = validateCommand(input)
  if (!validation.allowed) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      code: -1,
      blocked: true,
      reason: validation.reason,
    }
  }

  if (allowedRoots && allowedRoots.length > 0) {
    const normalizedCwd = path.resolve(cwd)
    const inAllowedRoot = allowedRoots.some((root) => {
      const normalizedRoot = path.resolve(root)
      return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(normalizedRoot + path.sep)
    })
    if (!inAllowedRoot) {
      return {
        success: false,
        stdout: "",
        stderr: "",
        code: -1,
        blocked: true,
        reason: `Working directory outside allowed roots`,
      }
    }
  }

  const parsed = parseCommand(input)
  if (!parsed) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      code: -1,
      blocked: true,
      reason: "Invalid command",
    }
  }

  try {
    const proc = Bun.spawn({
      cmd: [parsed.command, ...parsed.args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: process.env.PATH },
    })

    const timeoutId = setTimeout(() => proc.kill(), TIMEOUT_MS)

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    clearTimeout(timeoutId)

    return {
      success: code === 0,
      stdout: truncate(stdout.trim(), MAX_STDOUT),
      stderr: truncate(stderr.trim(), MAX_STDERR),
      code,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      stdout: "",
      stderr: message,
      code: -1,
    }
  }
}

export function formatShellResult(command: string, result: ShellResult): string {
  const parts: string[] = []

  if (result.blocked) {
    parts.push(`🚫 Blocked: ${result.reason}`)
    return parts.join("\n")
  }

  const icon = result.success ? "✓" : "✗"
  parts.push(`\`${command}\` ${icon}`)

  if (result.stdout) {
    parts.push("```")
    parts.push(result.stdout)
    parts.push("```")
  }

  if (result.stderr) {
    parts.push("stderr:")
    parts.push("```")
    parts.push(result.stderr)
    parts.push("```")
  }

  if (!result.stdout && !result.stderr && result.success) {
    parts.push("(no output)")
  }

  if (!result.success && result.code !== -1) {
    parts.push(`Exit code: ${result.code}`)
  }

  return parts.join("\n")
}
