# opencode-on-telegram

A Telegram bot that connects OpenCode AI to Telegram, featuring streaming responses, tool permission management, and session management.

## Prerequisites

- **[Bun](https://bun.sh)** runtime
- **[OpenCode CLI](https://opencode.ai)** installed and in PATH
- A Telegram bot token (`TELEGRAM_BOT_TOKEN`) from [@BotFather](https://t.me/BotFather)
- At least one AI provider API key (Anthropic, OpenAI, etc.)

### Installing OpenCode CLI

The bot requires the OpenCode CLI to be installed on your system:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Verify it's installed:

```bash
opencode --version
```

## Installation

```bash
bun install
```

## Configuration

Copy the example file and fill in the variables:

```bash
cp .env.example .env
```

Important variables (see `.env.example`):

- `TELEGRAM_BOT_TOKEN` *(required)*
- `ANTHROPIC_API_KEY` *(required)*
- `ALLOWED_USER_IDS` *(recommended)*: Authorized Telegram IDs (comma-separated)
- `OPENCODE_PORT` *(optional, default: 4097)*
- `OPENCODE_DEFAULT_DIR` *(optional, default: ~/)*
- `OPENCODE_MCP_CONFIG` *(optional, JSON)*
- `OPENAI_API_KEY` *(optional, audio transcription)*

## Running the bot

Development (watch):

```bash
bun run dev
```

Production:

```bash
bun run start
```

TypeScript check:

```bash
bun run typecheck
```

## Compiling to binary

```bash
bun run compile
```

Targets:

- `bun run compile:linux`
- `bun run compile:linux-arm`
- `bun run compile:windows`
- `bun run compile:all`

## Commands

List of commands to configure in BotFather (`/setcommands`):

```
start - Start the bot
menu - Open main menu
status - Show status panel
new - Start new conversation
cd - Change working directory for new sessions
model - Select AI model
mode - Switch between Plan/Build modes
auth - Manage provider authentication
git - Run git commands (status/log/diff/changes/branch/remote/show)
diff - Show session file changes
compact - Summarize/compact conversation
cost - Show usage statistics
help - Show help message with all commands
```

## Troubleshooting

### "OpenCode CLI not found"

Install the OpenCode CLI:

```bash
curl -fsSL https://opencode.ai/install | bash
```

### "Port 4097 is already in use"

A previous OpenCode server is still running. Find and kill it:

```bash
lsof -i :4097
kill <PID>
```

Or use a different port:

```bash
OPENCODE_PORT=4098 bun run src/index.ts
```

## Security notes

- Do not commit `.env`.
- Enable `ALLOWED_USER_IDS` if the bot should not be public.
