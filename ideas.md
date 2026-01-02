# Ideas & Roadmap

Feature ideas for OpenCode on Telegram, organized by priority.

---

## 1. Authentication & Provider Management

### OAuth / API Key Support
Allow users to connect their own AI provider accounts.

**Implementation:**
- `/auth` command opens provider selection menu (Anthropic, OpenAI, OpenRouter, etc.)
- For OAuth (Claude MAX): Use `provider.oauthAuthorize()` → user clicks link → `provider.oauthCallback()`
- For API keys: User sends key, bot stores it, immediately deletes message for security
- Store credentials in memory (single-user) or encrypted file

**SDK Methods:**
- `provider.list()` - Get available providers
- `auth.set({ path: { id }, body: { type: "api", key: "..." }})` - Set API key
- `provider.oauthAuthorize()` / `provider.oauthCallback()` - OAuth flow

---

## 2. Model Switching

### Quick Model Selection
Switch between models seamlessly from the interface.

**Implementation:**
- Add model indicator to menu: "Current: claude-sonnet-4"
- `/model` command shows inline keyboard with available models grouped by provider
- Store `userModel` preference, pass in `session.prompt({ body: { model: { providerID, modelID }}})`
- Show model in response footer: "claude-sonnet-4 · 12.3k tok · $0.042"

**UI Flow:**
```
/model
├── Anthropic
│   ├── claude-sonnet-4 ✓
│   ├── claude-opus-4
│   └── claude-haiku
├── OpenAI
│   ├── gpt-4o
│   └── o3
└── [Back] [Close]
```

**SDK Methods:**
- `provider.list()` - Get all providers with their models
- `config.providers()` - Get configured providers with defaults

---

## 3. Git Commands

### Safe Git Operations
Run common git commands with safety guards.

**Implementation:**
- `/git status` - Show working tree status (safe, no confirmation)
- `/git log` - Show recent commits (safe)
- `/git diff` - Show current changes beautifully formatted
- `/git branch` - List branches (safe)
- `/git changes` - **Beautiful visual diff of uncommitted changes**
- `/git push`, `/git commit` - Require inline keyboard confirmation

**Safety Levels:**
| Command | Safety | Confirmation |
|---------|--------|--------------|
| `status`, `log`, `diff`, `branch` | Safe | None |
| `add`, `commit`, `stash` | Moderate | Yes |
| `push`, `reset`, `checkout` | Dangerous | Yes + warning |

**Beautiful Changes View (`/git changes`):**
```
📊 Working Tree Changes

 M src/index.ts      (+42, -18)
 A src/utils.ts      (+156)
 D old-file.ts       (-89)

───────────────────
3 files changed, 198 insertions, 107 deletions

[View Full Diff] [Commit All] [Stash]
```

**SDK Methods:**
- `session.shell({ body: { command: "git status" }})` - Or use Bun.spawn directly
- `file.status()` - Get git status via SDK

---

## 4. Session Diff View

### View AI Changes
See what files the AI has modified in the current session.

**Implementation:**
- `/diff` - Show summary of all changes in current session
- Inline buttons: [Revert All] [View File] for each changed file
- Auto-show diff summary after AI makes edits (in response footer)

**Display Format:**
```
📝 Session Changes

src/index.ts
  +15 lines, -3 lines
  
src/utils.ts (new file)
  +42 lines

[Revert All] [Keep Changes]
```

**SDK Methods:**
- `session.diff({ path: { id: sessionId }})` - Get all diffs
- `session.revert()` - Undo changes

---

## 5. Compact/Summarize Session

### Compress Long Conversations
Reduce context size for long-running sessions.

**Implementation:**
- `/compact` command triggers summarization
- Show visual feedback during compression:
  ```
  🗜 Compacting conversation...
  ████████░░ 80%
  ```
- After completion:
  ```
  ✅ Compacted!
  
  Before: 45,231 tokens
  After:  8,420 tokens
  Saved:  81%
  
  Summary: "Implemented user authentication with JWT tokens,
  added login/logout endpoints, and created middleware..."
  ```

**SDK Methods:**
- `session.summarize({ path: { id: sessionId }})` - Compress session

---

## 6. Photo/Image Attachments

### Vision Support
Send images for the AI to analyze.

**Implementation:**
- Handle `message:photo` events in grammY
- Download image, convert to base64 data URL
- Include as file part in prompt:
  ```typescript
  parts: [
    { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,..." },
    { type: "text", text: caption || "What's in this image?" }
  ]
  ```
- Support multiple images in one message
- Show "🖼 Analyzing image..." during processing

**Supported Formats:**
- JPEG, PNG, GIF, WebP
- Telegram photos (auto-download largest size)
- Document attachments with image MIME types

---

## 7. Usage Statistics

### Cost Tracking
Track and display token usage and costs.

**Implementation:**
- `/cost` - Show usage summary
- Aggregate from `step-finish` events (tokens, cost)
- Store in `userStats` Map, persist optionally

**Display:**
```
📊 Usage Statistics

Today:
  Tokens: 124,532 (in: 98k, out: 26k)
  Cost: $0.847
  Messages: 23

This Week:
  Tokens: 892,103
  Cost: $6.12

[By Model] [By Day] [Export]
```

**Data Structure:**
```typescript
type UserStats = {
  daily: Map<string, { tokens: number, cost: number, messages: number }>
  byModel: Map<string, { tokens: number, cost: number }>
}
```

---

## 8. MCP Server Support

### External Tool Integration
Connect MCP servers for additional capabilities.

**Implementation:**
- Configure MCP servers in bot startup config or env
- `/mcp` command shows connected servers and their tools
- MCP tools appear in permission requests like built-in tools

**Config Example:**
```typescript
const MCP_SERVERS = [
  {
    name: "database",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-postgres"],
    env: { DATABASE_URL: process.env.DATABASE_URL }
  },
  {
    name: "browser",
    type: "remote", 
    url: "https://mcp.example.com/browser"
  }
]
```

**SDK Methods:**
- `mcp.status()` - Get server statuses
- `mcp.add()` - Add server dynamically
- `mcp.connect()` / `mcp.disconnect()` - Manage connections

---

## 9. Inline Query Support

### Use Bot in Any Chat
Trigger the bot inline from any Telegram chat.

**Implementation:**
- Handle `inline_query` events
- Create temporary session for quick questions
- Return response as inline query result

**Usage:**
```
@opencode_bot explain async/await in TypeScript
```

**Flow:**
1. User types `@botname <query>` in any chat
2. Bot creates temp session, sends prompt
3. Wait for response (with timeout)
4. Return as `InlineQueryResultArticle`
5. User taps result to send to chat

**Considerations:**
- Set reasonable timeout (10-15 seconds)
- Cache common queries
- Limit response length for inline results
- Show "thinking..." placeholder while processing

---

## 10. Todo List Auto-Display

### Automatic Task Visibility
Show AI's todo list automatically during work.

**Implementation:**
- Listen for `todo.updated` events
- When AI creates/updates todos, show in message:
  ```
  📋 Tasks:
  ✅ Set up project structure
  🔄 Implement authentication  ← in progress
  ⬜ Add unit tests
  ⬜ Write documentation
  ```
- Update inline as tasks complete
- Collapse when all done, show summary

**SDK Methods:**
- `session.todo({ path: { id }})` - Get current todos
- Listen for `todo.updated` events in stream

---

## Bonus Features

### Voice Message Support
Send voice messages for transcription and processing.

**Implementation:**
- Handle `message:voice` events
- Download OGG file from Telegram
- Transcribe using Whisper API (OpenAI) or local whisper.cpp
- Send transcribed text to OpenCode
- Optionally: Reply with TTS audio

**Flow:**
```
User: [Voice: "Can you explain how the auth middleware works?"]
Bot: 🎤 Transcribing...
Bot: 💭 Thinking...
Bot: [Response about auth middleware]
```

**Nice-to-have:**
- Show transcription before AI response for confirmation
- Support voice reply toggle in settings

---

## Implementation Priority

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| 1 | Model switching | Low | High |
| 2 | Photo attachments | Low | High |
| 3 | `/git` commands | Medium | High |
| 4 | `/diff` view | Low | Medium |
| 5 | `/compact` | Low | Medium |
| 6 | `/cost` stats | Low | Medium |
| 7 | Auth/OAuth | Medium | Medium |
| 8 | Todo auto-display | Low | Medium |
| 9 | Inline queries | Medium | Medium |
| 10 | MCP servers | Medium | Low |
| Bonus | Voice messages | Medium | Low |

---

## Technical Notes

### SDK Methods Quick Reference
```typescript
// Sessions
session.create(), session.list(), session.delete()
session.prompt(), session.abort()
session.diff(), session.revert(), session.summarize()
session.todo(), session.fork(), session.share()

// Providers
provider.list(), auth.set()
provider.oauthAuthorize(), provider.oauthCallback()

// Files
file.list(), file.read(), file.status()
find.text(), find.files(), find.symbols()

// MCP
mcp.status(), mcp.add(), mcp.connect()

// Events
event.subscribe() → message.part.updated, permission.updated, todo.updated, etc.
```

### Prompt Body Options
```typescript
session.prompt({
  path: { id: sessionId },
  body: {
    model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    agent: "build" | "plan" | "explore",
    system: "Custom system prompt...",
    tools: { bash: false, webfetch: true },
    noReply: true,  // Inject context silently
    parts: [
      { type: "text", text: "..." },
      { type: "file", mime: "image/png", url: "data:..." }
    ]
  }
})
```
