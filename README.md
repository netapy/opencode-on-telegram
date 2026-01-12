# opencode-on-telegram

A Telegram bot that connects OpenCode AI to Telegram, featuring streaming responses, tool permission management, session management, and persistent state.

## Features

- **Real-time Streaming**: Watch AI responses as they're generated
- **Permission Profiles**: Strict/Balanced/Power modes for tool auto-approval
- **Group Chat Scoping**: Per-user, per-thread, or shared sessions in groups
- **Persistent State**: SQLite-backed settings, sessions, and usage stats
- **Secret Redaction**: Auto-redact API keys and credentials in displays
- **Workspace Safety**: Directory boundary enforcement
- **Undo/Revert**: Rollback file edits and git operations
- **Export**: Conversation export to Markdown/JSON/HTML
- **History Search**: Full-text search across conversation history
- **Task Workflows**: One-tap quick actions for common tasks
- **File Upload**: Support for images and text files
- **Voice Transcription**: Speech-to-text via OpenAI Whisper
- **Git Integration**: Safe/confirmable git commands

## Prerequisites

- **[Bun](https://bun.sh)** runtime
- **[OpenCode CLI](https://opencode.ai)** installed and in PATH
- A Telegram bot token (`TELEGRAM_BOT_TOKEN`) from [@BotFather](https://t.me/BotFather)
- At least one AI provider API key (Anthropic, OpenAI, etc.)

### Installing OpenCode CLI

```bash
curl -fsSL https://opencode.ai/install | bash
opencode --version
```

## Installation

```bash
bun install
```

## Configuration

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `ANTHROPIC_API_KEY` | Yes | OpenCode/Anthropic API key |
| `ALLOWED_USER_IDS` | Recommended | Comma-separated Telegram user IDs |
| `OPENCODE_PORT` | No | Default: 4097 |
| `OPENCODE_DEFAULT_DIR` | No | Default session directory |
| `OPENCODE_MCP_CONFIG` | No | MCP config JSON |
| `OPENAI_API_KEY` | No | For voice transcription |
| `OPENCODE_DB_PATH` | No | SQLite path (default: ./opencode-telegram.db) |

## Running

Development (watch mode):

```bash
bun run dev
```

Production:

```bash
bun run start
```

Type check:

```bash
bun run typecheck
```

Run tests:

```bash
bun run scripts/test-harness.ts
```

## Compiling to binary

```bash
bun run compile        # Current platform
bun run compile:linux  # Linux x64
bun run compile:linux-arm  # Linux ARM64
bun run compile:windows    # Windows x64
bun run compile:all        # All platforms
```

## Commands

Configure in BotFather (`/setcommands`):

```
start - Start the bot
menu - Open main menu
status - Show status panel
new - Start new conversation
sessions - Manage sessions (list/switch/info/delete)
cd - Change working directory
model - Select AI model
mode - Switch Plan/Build modes
profile - Permission profile (strict/balanced/power)
scope - Group chat scope mode
auth - Manage provider authentication
git - Run git commands
diff - Show session file changes
compact - Summarize conversation
cost - Show usage statistics
export - Export conversation
history - View message history
undo - Undo last action
workflow - Quick task workflows
help - Show help message
```

### Shell Access

Run shell commands directly with `!` prefix:

```
!ls -la
!git status
!cat package.json
!pwd
```

**Blocked commands**: `sudo`, `curl`, `wget`, `npm`, `pip`, `rm -rf`, and shell operators (`&&`, `|`, `;`, `>`)

## Permission Profiles

- **Strict**: Ask for every action (nothing auto-allowed)
- **Balanced**: Auto-allow reads, ask for writes (default)
- **Power**: Auto-allow most, ask for destructive only

## Group Chat Scopes

- **User**: Isolated sessions per user (private)
- **Thread**: Shared sessions per topic/thread
- **Shared**: Single shared session for all users

## Troubleshooting

### "OpenCode CLI not found"

```bash
curl -fsSL https://opencode.ai/install | bash
```

### "Port 4097 is already in use"

```bash
lsof -i :4097
kill <PID>
# Or use a different port:
OPENCODE_PORT=4098 bun run start
```

## Security

- Never commit `.env`
- Enable `ALLOWED_USER_IDS` for private bots
- Secrets are auto-redacted in message displays
- Set `allowedRoots` in user settings for workspace boundaries
