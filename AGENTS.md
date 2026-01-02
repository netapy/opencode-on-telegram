# AGENTS.md - Coding Agent Guidelines

This document provides guidelines for AI coding agents working on this codebase.

## Project Overview

OpenCode on Telegram - A Telegram bot that interfaces with OpenCode AI, featuring real-time streaming responses, permission management for AI tool usage, and session/conversation management.

**Runtime:** Bun (not Node.js)
**Language:** TypeScript with strict mode

## Build/Run Commands

```bash
# Development (watch mode)
bun run dev

# Production
bun run start

# Type checking (no emit)
bun run typecheck

# Compile to native binary
bun run compile           # Current platform
bun run compile:linux     # Linux x64
bun run compile:linux-arm # Linux ARM64
bun run compile:windows   # Windows x64
bun run compile:all       # All platforms
```

## Testing

**No automated test framework is configured.** Manual testing is done via:

```bash
# Debug script for testing OpenCode events without Telegram
bun run scripts/opencode-event-debug.ts
```

When adding features, test manually by running `bun run dev` and interacting with the Telegram bot.

## Project Structure

```
opencode-on-telegram/
├── src/
│   └── index.ts           # Main application (Telegram bot + OpenCode integration)
├── scripts/
│   └── opencode-event-debug.ts  # Debug/test script
├── package.json
├── tsconfig.json
├── .env.example           # Environment variable template
└── bun.lock
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `ANTHROPIC_API_KEY` | Yes | OpenCode/Anthropic API key |
| `ALLOWED_USER_IDS` | No | Comma-separated Telegram user IDs for access control |
| `OPENCODE_PORT` | No | Defaults to 4097 |

## Code Style Guidelines

### Imports

- Use ES Modules (`import { ... } from "..."`)
- Prefer named imports over default imports
- Use inline `type` keyword for type-only imports:
  ```typescript
  import { createOpencode, type Event, type Session } from "@opencode-ai/sdk";
  ```
- Order: external dependencies first, then internal modules

### Formatting

- **Indentation:** 2 spaces
- **Quotes:** Double quotes for strings
- **Semicolons:** None (Bun/modern style)
- **Trailing commas:** Yes, in multi-line structures
- **Line spacing:** Single blank line between function definitions
- **Max line length:** ~100 characters (soft limit)

### TypeScript Conventions

- Strict mode is enabled (`strict: true` in tsconfig)
- Use explicit interface definitions for state objects (`DisplayState`, `ActiveMessage`, `MenuState`)
- Use type aliases for complex types
- Prefer `Record<K, V>` for object dictionaries
- Use `Map<K, V>` and `Set<V>` for runtime data structures
- Non-null assertions (`!`) are acceptable for validated env vars:
  ```typescript
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
  ```

### Naming Conventions

- **Functions:** camelCase, verb-first (`createDisplayState`, `renderDisplay`, `parseMessageKey`)
- **Variables:** camelCase (`userSessions`, `activeMessages`)
- **Constants:** SCREAMING_SNAKE_CASE (`TELEGRAM_BOT_TOKEN`, `UPDATE_INTERVAL_MS`)
- **Interfaces/Types:** PascalCase (`DisplayState`, `ActiveMessage`, `MenuState`)
- **Object dictionaries:** SCREAMING_SNAKE_CASE (`TOOL_ICONS`, `PERMISSION_ICONS`)

### Error Handling

- Use `try/catch` blocks with appropriate error swallowing
- Use `.catch(() => {})` for non-critical async operations
- Log errors via `console.error()` with descriptive prefixes
- Exit with `process.exit(1)` for fatal startup errors
- Graceful degradation: operations should fail silently when appropriate

### Async Patterns

- Use `async/await` throughout
- Use `void` prefix for fire-and-forget async calls:
  `void opencode.session.abort({ path: { id: sessionId } }).catch(() => {})`
- Use async iterables for event streams:
  `for await (const event of events.stream as AsyncIterable<Event>) { ... }`

### Function Design

- Keep functions focused and single-purpose
- Use parameter objects for functions with many parameters
- Return early for guard clauses
- Prefer pure functions where possible

### State Management

- Use `Map<K, V>` for per-user/per-message state
- Use composite keys for message identification: `${chatId}:${messageId}`
- Clear state entries when no longer needed

### UI Patterns (Telegram-specific)

- Use inline keyboards for interactive elements
- Throttle message updates (800ms interval, 30 char minimum delta)
- Split long messages (>4096 chars) into chunks
- Use emojis as visual indicators in UI elements

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@opencode-ai/sdk` | OpenCode AI client |
| `grammy` | Telegram Bot framework |
| `@grammyjs/auto-retry` | Automatic retry for Telegram API |
| `@grammyjs/parse-mode` | Parse mode helpers |
| `telegramify-markdown` | Markdown conversion for Telegram |

## What to Avoid

- Do NOT use Node.js-specific APIs (use Bun equivalents)
- Do NOT add semicolons
- Do NOT use `var` (use `const` or `let`)
- Do NOT ignore TypeScript errors - fix them
- Do NOT commit `.env` files or secrets
- Do NOT use `any` type without justification
