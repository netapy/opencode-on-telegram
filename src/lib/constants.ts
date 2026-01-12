export const UPDATE_INTERVAL_MS = 1000
export const MIN_CHARS_DELTA = 30
export const INLINE_QUERY_TIMEOUT_MS = 12000
export const INLINE_QUERY_MAX_CHARS = 1800
export const MENU_PAGE_SIZE = 6
export const MODEL_PAGE_SIZE = 6
export const GIT_CONFIRM_TTL_MS = 5 * 60 * 1000
export const MAX_OUTPUT_CHARS = 3500
export const MAX_TODO_ITEMS = 8
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const BRANCH_CACHE_MS = 30000
export const POLL_INITIAL_MS = 400
export const POLL_MAX_MS = 5000
export const STABLE_POLL_COUNT = 4
export const MIN_STABLE_MS = 3000
export const WORKING_PING_MS = 60000
export const TELEGRAM_MAX_MESSAGE = 4096
export const TELEGRAM_SAFE_MESSAGE = 3800
export const TELEGRAM_PARSE_MODE = "MarkdownV2" as const
export const MAX_DIR_ENTRIES = 12
export const MAX_RECENT_DIRS = 6
export const MAX_DIR_LABEL = 28
export const MAX_SESSION_LABEL = 48
export const MAX_BREADCRUMB_TOOLS = 8
export const BREADCRUMB_FULL_NAME_COUNT = 3
export const MAX_RECENT_MODELS = 3
export const RAW_MARKDOWN_SAFE_LIMIT = 2800

export const SESSION_DIVIDER_LINE = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

export const TOOL_ICONS: Record<string, string> = {
  read: "📖",
  edit: "✏️",
  write: "📝",
  bash: "⚡",
  glob: "🔍",
  grep: "🔎",
  webfetch: "🌐",
  task: "🤖",
  todowrite: "📋",
  todoread: "📋",
}

export const PERMISSION_ICONS: Record<string, string> = {
  edit: "✏️",
  write: "📝",
  bash: "⚡",
  delete: "🗑️",
}

export const TODO_STATUS_ICONS: Record<string, string> = {
  pending: "⬜",
  in_progress: "🔄",
  completed: "✅",
  cancelled: "⏹",
}

export const GIT_SAFE_COMMANDS = new Set([
  "status",
  "log",
  "diff",
  "branch",
  "remote",
  "show",
])

export const GIT_CONFIRM_COMMANDS = new Set([
  "add",
  "commit",
  "stash",
  "push",
  "reset",
  "checkout",
  "switch",
  "restore",
])

export const GIT_USAGE_TEXT = "Usage: /git status | log | diff | changes | branch | remote | show"

export const HELP_TEXT = `OpenCode on Telegram

Commands:
/start - Welcome message and status
/menu - Open interactive menu
/status - Show current status panel
/new - Start a new conversation
/sessions - Manage sessions (list/switch/info/delete)
/cd [path] - Change working directory
/model - Select AI model
/mode - Switch between Plan/Build modes
/profile - Permission profile (strict/balanced/power)
/scope - Group chat scope mode
/auth - Manage provider authentication
/git <cmd> - Run git commands
/diff - Show file changes in session
/compact - Summarize conversation
/cost - Show usage statistics
/export - Export conversation
/history - View message history
/undo - Undo last action
/workflow - Quick task workflows
/help - Show this help message

Shell Access:
!<command> - Run shell command directly (e.g. !ls -la)

Tips:
- Send any text to chat with the AI
- Send images, documents, or voice messages
- Use the menu for quick access to features
- Nudge the AI by sending messages while it's working

Safety:
- /profile to control auto-permissions
- /scope to control group chat isolation
- Secrets are auto-redacted in displays`

export const SUPPORTED_FILE_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-python",
  "text/javascript",
  "text/typescript",
  "text/css",
  "text/html",
  "text/xml",
  "text/csv",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-shellscript",
])

export const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".py",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".css",
  ".html",
  ".xml",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".sql",
  ".graphql",
  ".prisma",
  ".env",
  ".gitignore",
  ".dockerfile",
  ".makefile",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".lua",
  ".r",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".ml",
  ".vue",
  ".svelte",
])
