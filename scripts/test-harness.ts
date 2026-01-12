import * as db from "../src/lib/db.js"
import * as redact from "../src/lib/redact.js"
import * as permissions from "../src/lib/permissions.js"
import * as workflows from "../src/lib/workflows.js"
import * as safety from "../src/lib/safety.js"
import * as scope from "../src/lib/scope.js"
import * as undoLib from "../src/lib/undo.js"
import * as exportLib from "../src/lib/export.js"
import * as utils from "../src/lib/utils.js"
import * as constants from "../src/lib/constants.js"
import * as shell from "../src/lib/shell.js"
import type { Permission } from "@opencode-ai/sdk"

process.env.OPENCODE_DB_PATH = ":memory:"

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = []

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn()
    if (result instanceof Promise) {
      result.then(() => { results.push({ name, passed: true }); console.log(`✅ ${name}`) })
        .catch(err => { results.push({ name, passed: false, error: String(err) }); console.log(`❌ ${name}: ${err}`) })
    } else { results.push({ name, passed: true }); console.log(`✅ ${name}`) }
  } catch (err) { results.push({ name, passed: false, error: String(err) }); console.log(`❌ ${name}: ${err}`) }
}

function assert(condition: boolean, message: string): void { if (!condition) throw new Error(message) }
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}

console.log("\n🧪 OpenCode Telegram Bot - Test Suite\n")
console.log("=".repeat(60))

console.log("\n📦 DATABASE TESTS\n")

test("DB: Schema initialization", () => { db.getDb() })

test("DB: User settings CRUD", () => {
  const settings = { agentMode: "build" as const, permissionProfile: "balanced" as const, defaultDirectory: "/home/test", scopeMode: "user" as const, secretRedaction: true }
  db.saveUserSettings(1001, settings)
  const loaded = db.loadUserSettings(1001)
  assert(loaded !== null, "Settings should load")
  assertEqual(loaded!.agentMode, "build", "Agent mode")
  assertEqual(loaded!.permissionProfile, "balanced", "Permission profile")
  assertEqual(loaded!.secretRedaction, true, "Secret redaction")
})

test("DB: Chat session persistence", () => {
  db.saveChatSession("chat:1001", "session-xyz")
  assertEqual(db.loadChatSession("chat:1001"), "session-xyz", "Session ID")
  db.saveChatSession("chat:1001", "session-abc")
  assertEqual(db.loadChatSession("chat:1001"), "session-abc", "Updated session")
})

test("DB: Session directory cache", () => {
  db.saveSessionDirectory("sess-1", "/project/a")
  assertEqual(db.loadSessionDirectory("sess-1"), "/project/a", "Directory")
})

test("DB: Session title cache", () => {
  db.saveSessionTitle("sess-2", "My Conversation")
  assertEqual(db.loadSessionTitle("sess-2"), "My Conversation", "Title")
})

test("DB: Recent directories (LRU)", () => {
  for (let i = 0; i < 10; i++) db.saveRecentDirectory("ctx:lru", `/dir/${i}`)
  const recent = db.loadRecentDirectories("ctx:lru")
  assert(recent.length <= 6, "Should limit to 6")
  assertEqual(recent[0], "/dir/9", "Most recent first")
})

test("DB: Recent models (LRU)", () => {
  for (let i = 0; i < 5; i++) db.saveRecentModel(2001, `provider${i}`, `model${i}`, `provider${i}/model${i}`)
  const recent = db.loadRecentModels(2001)
  assert(recent.length <= 3, "Should limit to 3")
  assertEqual(recent[0].providerID, "provider4", "Most recent first")
})

test("DB: Usage stats aggregation", () => {
  const userId = Date.now()
  const dateKey = utils.getDateKey()
  db.recordUsage(userId, "claude-3", dateKey, 500, 0.02, 1)
  db.recordUsage(userId, "claude-3", dateKey, 300, 0.01, 1)
  db.recordUsage(userId, "gpt-4", dateKey, 200, 0.015, 1)
  const stats = db.loadUsageStats(userId)
  assertEqual(stats.totalTokens, 1000, "Total tokens")
  assertEqual(stats.totalMessages, 3, "Total messages")
  assert(stats.byModel.has("claude-3"), "Should track by model")
  assertEqual(stats.byModel.get("claude-3")!.tokens, 800, "Claude tokens")
})

test("DB: Undo stack (LIFO)", () => {
  const userId = Date.now()
  const id1 = crypto.randomUUID()
  const id2 = crypto.randomUUID()
  db.pushUndo(userId, { id: id1, type: "file", timestamp: Date.now(), description: "edit a.txt", data: {} })
  db.pushUndo(userId, { id: id2, type: "file", timestamp: Date.now() + 1, description: "edit b.txt", data: {} })
  const popped = db.popUndo(userId)
  assertEqual(popped!.id, id2, "LIFO order")
})

test("DB: History search", () => {
  db.saveHistoryEntry({ id: "h1", sessionId: "search-sess", role: "user", timestamp: Date.now(), text: "How do I use TypeScript generics?" })
  db.saveHistoryEntry({ id: "h2", sessionId: "search-sess", role: "assistant", timestamp: Date.now() + 1, text: "TypeScript generics allow you to write reusable code." })
  const results = db.searchHistory("search-sess", "TypeScript", 10)
  assertEqual(results.length, 2, "Should find both messages")
})

test("DB: Session history for context", () => {
  const sessionId = "context-test-sess"
  db.saveHistoryEntry({ id: "ctx1", sessionId, role: "user", timestamp: 1000, text: "First user message" })
  db.saveHistoryEntry({ id: "ctx2", sessionId, role: "assistant", timestamp: 2000, text: "First assistant response" })
  db.saveHistoryEntry({ id: "ctx3", sessionId, role: "user", timestamp: 3000, text: "Second user message" })
  db.saveHistoryEntry({ id: "ctx4", sessionId, role: "assistant", timestamp: 4000, text: "Second assistant response" })
  const recent = db.getSessionHistory(sessionId, 3, 0)
  assertEqual(recent.length, 3, "Should get 3 recent entries")
  assertEqual(recent[0].text, "Second assistant response", "First is newest (DESC order)")
  assertEqual(recent[2].text, "First assistant response", "Last is oldest of the 3")
  const reversed = [...recent].reverse()
  assertEqual(reversed[0].text, "First assistant response", "Reversed: oldest first")
  assertEqual(reversed[2].text, "Second assistant response", "Reversed: newest last")
})

test("DB: Permission overrides", () => {
  db.savePermissionOverride(5001, "bash", "/safe/*", "allow")
  db.savePermissionOverride(5001, "edit", null, "ask")
  const overrides = db.loadPermissionOverrides(5001)
  assert(overrides.length >= 2, "Should have overrides")
})

console.log("\n🔐 SECRET REDACTION TESTS\n")

test("Redact: OpenAI API keys", () => {
  const text = "Use this key: sk-proj-1234567890abcdefghijklmnop"
  const redacted = redact.redactSecrets(text)
  assert(!redacted.includes("sk-proj-"), "Should redact")
  assert(redacted.includes("[REDACTED"), "Should show marker")
})

test("Redact: GitHub tokens (classic)", () => {
  const text = "Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890"
  assert(!redact.redactSecrets(text).includes("ghp_"), "Should redact")
})

test("Redact: GitHub tokens (fine-grained)", () => {
  const text = "Token: github_pat_11ABCDEFG_abcdefghijklmnop"
  assert(!redact.redactSecrets(text).includes("github_pat_"), "Should redact")
})

test("Redact: AWS access keys", () => {
  const text = "AWS_KEY=AKIAIOSFODNN7EXAMPLE"
  assert(!redact.redactSecrets(text).includes("AKIAIOSFODNN"), "Should redact")
})

test("Redact: JWT tokens", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  assert(!redact.redactSecrets(`Bearer ${jwt}`).includes("eyJ"), "Should redact JWT")
})

test("Redact: ENV file values", () => {
  const env = "DATABASE_PASSWORD=supersecret123\nAPI_TOKEN=abc123xyz"
  const redacted = redact.redactSecrets(env)
  assert(!redacted.includes("supersecret123"), "Should redact password")
  assert(!redacted.includes("abc123xyz"), "Should redact token")
})

test("Redact: Private keys", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----"
  assert(!redact.redactSecrets(key).includes("MIIEvQIBADANBg"), "Should redact private key")
})

test("Redact: containsSecrets detection", () => {
  assert(redact.containsSecrets("sk-test123456789012345678901234"), "Should detect API key")
  assert(!redact.containsSecrets("Hello world, this is normal text"), "Should not detect normal text")
})

console.log("\n🔒 PERMISSION PROFILE TESTS\n")

test("Permission: Strict profile blocks all", () => {
  const set = permissions.getAutoAllowSet("strict")
  assertEqual(set.size, 0, "Strict allows nothing")
})

test("Permission: Balanced profile allows reads", () => {
  const set = permissions.getAutoAllowSet("balanced")
  assert(set.has("read"), "Allows read")
  assert(set.has("glob"), "Allows glob")
  assert(set.has("grep"), "Allows grep")
  assert(!set.has("bash"), "Blocks bash")
  assert(!set.has("edit"), "Blocks edit")
})

test("Permission: Power profile allows most", () => {
  const set = permissions.getAutoAllowSet("power")
  assert(set.has("bash"), "Allows bash")
  assert(set.has("edit"), "Allows edit")
  assert(set.has("write"), "Allows write")
})

test("Permission: shouldAutoAllow respects profile", () => {
  const readPerm = { type: "read", id: "1", title: "Read", sessionID: "s1", metadata: {} } as Permission
  const bashPerm = { type: "bash", id: "2", title: "Bash", sessionID: "s1", metadata: {} } as Permission
  assert(permissions.shouldAutoAllow(readPerm, "balanced"), "Balanced allows read")
  assert(!permissions.shouldAutoAllow(bashPerm, "balanced"), "Balanced blocks bash")
  assert(!permissions.shouldAutoAllow(readPerm, "strict"), "Strict blocks read")
  assert(permissions.shouldAutoAllow(bashPerm, "power"), "Power allows bash")
})

test("Permission: Profile cycling", () => {
  assertEqual(permissions.getNextProfile("strict"), "balanced", "Strict -> Balanced")
  assertEqual(permissions.getNextProfile("balanced"), "power", "Balanced -> Power")
  assertEqual(permissions.getNextProfile("power"), "strict", "Power -> Strict")
})

console.log("\n📋 WORKFLOW TESTS\n")

test("Workflow: Builtin workflows exist", () => {
  assert(workflows.BUILTIN_WORKFLOWS.length >= 5, "Should have builtin workflows")
})

test("Workflow: Get by ID", () => {
  const wf = workflows.getWorkflow("debug-error")
  assert(wf !== undefined, "Should find workflow")
  assertEqual(wf!.name, "Debug Error", "Name")
  assert(wf!.prompt.length > 0, "Has prompt")
})

test("Workflow: All workflows have required fields", () => {
  for (const wf of workflows.BUILTIN_WORKFLOWS) {
    assert(wf.id.length > 0, `${wf.name} has id`)
    assert(wf.name.length > 0, `${wf.id} has name`)
    assert(wf.icon.length > 0, `${wf.id} has icon`)
    assert(wf.prompt.length > 0, `${wf.id} has prompt`)
  }
})

test("Workflow: Prompt with context", () => {
  const wf = workflows.getWorkflow("refactor-file")!
  const prompt = workflows.getWorkflowPrompt(wf, "File: utils.ts\nFunction: parseArgs")
  assert(prompt.includes("refactor"), "Has base prompt")
  assert(prompt.includes("utils.ts"), "Has context")
})

console.log("\n🛡️ SAFETY TESTS\n")

test("Safety: Path within allowed root", () => {
  assertEqual(safety.checkPathSafety("/home/user/project/src/file.ts", ["/home/user/project"]).allowed, true, "Allowed")
})

test("Safety: Path outside allowed root", () => {
  const check = safety.checkPathSafety("/etc/passwd", ["/home/user/project"])
  assertEqual(check.allowed, false, "Blocked")
  assert(check.reason!.includes("outside"), "Has reason")
})

test("Safety: Subdirectory of root allowed", () => {
  assertEqual(safety.checkPathSafety("/home/user/project/deep/nested/file.ts", ["/home/user/project"]).allowed, true, "Allowed")
})

test("Safety: Multiple roots", () => {
  const roots = ["/home/user/project1", "/home/user/project2"]
  assert(safety.checkPathSafety("/home/user/project1/file.ts", roots).allowed, "Root 1 allowed")
  assert(safety.checkPathSafety("/home/user/project2/file.ts", roots).allowed, "Root 2 allowed")
  assert(!safety.checkPathSafety("/home/user/project3/file.ts", roots).allowed, "Other blocked")
})

test("Safety: No roots = allow all", () => {
  assert(safety.checkPathSafety("/etc/passwd", undefined).allowed, "Undefined allows all")
  assert(safety.checkPathSafety("/etc/passwd", []).allowed, "Empty allows all")
})

test("Safety: Dangerous command detection", () => {
  assert(!safety.checkCommandSafety("rm -rf /").allowed, "Blocks rm -rf /")
  assert(!safety.checkCommandSafety("rm -rf ~").allowed, "Blocks rm -rf ~")
  assert(!safety.checkCommandSafety(":(){:|:&};:").allowed, "Blocks fork bomb")
})

test("Safety: Safe commands allowed", () => {
  assert(safety.checkCommandSafety("ls -la").allowed, "ls allowed")
  assert(safety.checkCommandSafety("cat file.txt").allowed, "cat allowed")
  assert(safety.checkCommandSafety("git status").allowed, "git status allowed")
})

console.log("\n👥 SCOPE TESTS\n")

test("Scope: Private chat key", () => {
  assertEqual(scope.buildScopeKey({ chatId: 123, chatType: "private", mode: "user" }), "123", "Simple key")
})

test("Scope: Private chat with thread", () => {
  assertEqual(scope.buildScopeKey({ chatId: 123, chatType: "private", threadId: 456, mode: "user" }), "123:456", "Thread key")
})

test("Scope: Group user-isolated", () => {
  assertEqual(scope.buildScopeKey({ chatId: 123, chatType: "group", userId: 789, mode: "user" }), "123:user:789", "User key")
})

test("Scope: Group thread-based", () => {
  assertEqual(scope.buildScopeKey({ chatId: 123, chatType: "group", threadId: 456, mode: "thread" }), "123:thread:456", "Thread key")
})

test("Scope: Group shared", () => {
  assertEqual(scope.buildScopeKey({ chatId: 123, chatType: "group", mode: "shared" }), "123", "Shared key")
})

test("Scope: Parse user key", () => {
  const parsed = scope.parseScopeKey("123:user:456")
  assert(parsed !== null, "Should parse")
  assertEqual(parsed!.chatId, 123, "Chat ID")
  assertEqual(parsed!.userId, 456, "User ID")
  assertEqual(parsed!.mode, "user", "Mode")
})

test("Scope: Parse thread key", () => {
  const parsed = scope.parseScopeKey("123:thread:789")
  assert(parsed !== null, "Should parse")
  assertEqual(parsed!.threadId, 789, "Thread ID")
  assertEqual(parsed!.mode, "thread", "Mode")
})

test("Scope: Mode cycling", () => {
  assertEqual(scope.getNextScopeMode("user"), "thread", "User -> Thread")
  assertEqual(scope.getNextScopeMode("thread"), "shared", "Thread -> Shared")
  assertEqual(scope.getNextScopeMode("shared"), "user", "Shared -> User")
})

console.log("\n📤 EXPORT TESTS\n")

test("Export: Markdown format", () => {
  db.saveHistoryEntry({ id: "exp-md-1", sessionId: "export-md", role: "user", timestamp: Date.now(), text: "Hello AI" })
  db.saveHistoryEntry({ id: "exp-md-2", sessionId: "export-md", role: "assistant", timestamp: Date.now() + 1, text: "Hello human" })
  const exported = exportLib.exportSession("export-md", "Test Export", { format: "markdown", redactSecrets: false })
  assert(exported.includes("# Test Export"), "Has title")
  assert(exported.includes("Hello AI"), "Has user message")
  assert(exported.includes("Hello human"), "Has assistant message")
  assert(exported.includes("User"), "Has role labels")
})

test("Export: JSON format", () => {
  const exported = exportLib.exportSession("export-md", "JSON Test", { format: "json", redactSecrets: false })
  const parsed = JSON.parse(exported)
  assertEqual(parsed.title, "JSON Test", "Title")
  assert(Array.isArray(parsed.messages), "Has messages array")
  assert(parsed.messages.length >= 2, "Has messages")
})

test("Export: HTML format", () => {
  const exported = exportLib.exportSession("export-md", "HTML Test", { format: "html", redactSecrets: false })
  assert(exported.includes("<!DOCTYPE html>"), "Has doctype")
  assert(exported.includes("<title>"), "Has title tag")
  assert(exported.includes("Hello AI"), "Has content")
})

test("Export: With redaction", () => {
  db.saveHistoryEntry({ id: "exp-redact", sessionId: "export-secret", role: "assistant", timestamp: Date.now(), text: "Your API key is sk-1234567890abcdefghijklmnop" })
  const exported = exportLib.exportSession("export-secret", "Secret Test", { format: "markdown", redactSecrets: true })
  assert(!exported.includes("sk-1234567890"), "Should redact")
  assert(exported.includes("[REDACTED"), "Should show marker")
})

test("Export: Filename generation", () => {
  const md = exportLib.getExportFilename("Test Session", "markdown")
  const json = exportLib.getExportFilename("Test Session", "json")
  const html = exportLib.getExportFilename("Test Session", "html")
  assert(md.endsWith(".md"), "Markdown extension")
  assert(json.endsWith(".json"), "JSON extension")
  assert(html.endsWith(".html"), "HTML extension")
  assert(md.includes("Test_Session"), "Has sanitized title")
})

console.log("\n🔄 UNDO TESTS\n")

test("Undo: Format entry", () => {
  const entry = { id: "u1", type: "file" as const, timestamp: Date.now(), description: "edit config.json", data: {} }
  const formatted = undoLib.formatUndoEntry(entry)
  assert(formatted.includes("📄"), "Has file icon")
  assert(formatted.includes("config.json"), "Has description")
})

test("Undo: Git entry format", () => {
  const entry = { id: "u2", type: "git" as const, timestamp: Date.now(), description: "checkout main", data: {} }
  const formatted = undoLib.formatUndoEntry(entry)
  assert(formatted.includes("🔀"), "Has git icon")
})

console.log("\n🛠️ UTILITY TESTS\n")

test("Utils: truncate", () => {
  assertEqual(utils.truncate("Hello", 10), "Hello", "Short text unchanged")
  assertEqual(utils.truncate("Hello World!", 8), "Hello...", "Long text truncated")
})

test("Utils: formatShortPath", () => {
  assertEqual(utils.formatShortPath("/home/user/project/src"), "…/project/src", "Deep path")
  assertEqual(utils.formatShortPath("/home"), "/home", "Short path")
})

test("Utils: cleanSessionTitle", () => {
  assertEqual(utils.cleanSessionTitle("Chat - 2026-01-06T12:00:00Z"), "Chat", "Removes timestamp")
  assertEqual(utils.cleanSessionTitle("  -  "), "Untitled", "Handles empty")
})

test("Utils: formatRelativeTime", () => {
  const now = Date.now()
  assertEqual(utils.formatRelativeTime(now), "now", "Just now")
  assertEqual(utils.formatRelativeTime(now - 60000), "1m", "1 minute ago")
  assertEqual(utils.formatRelativeTime(now - 3600000), "1h", "1 hour ago")
})

test("Utils: parseCommandArgs", () => {
  const args = utils.parseCommandArgs('/git commit -m "Hello world"')
  assertEqual(args.length, 4, "Parses 4 args")
  assertEqual(args[0], "/git", "Command")
  assertEqual(args[3], "Hello world", "Quoted arg without quotes")
})

test("Utils: messageKey", () => {
  assertEqual(utils.messageKey(123, 456), "123:456", "Key format")
})

test("Utils: parseMessageKey", () => {
  const parsed = utils.parseMessageKey("123:456")
  assertEqual(parsed!.chatId, 123, "Chat ID")
  assertEqual(parsed!.messageId, 456, "Message ID")
})

test("Utils: splitRawMarkdown", () => {
  const long = "A".repeat(5000)
  const chunks = utils.splitRawMarkdown(long, 2000)
  assert(chunks.length > 1, "Splits long text")
  assert(chunks.every(c => c.length <= 2000), "All chunks within limit")
})

test("Utils: resolveDirectoryInput", () => {
  assertEqual(utils.resolveDirectoryInput("~", "/base"), process.env.HOME!, "Tilde expands")
  assertEqual(utils.resolveDirectoryInput("/abs/path", "/base"), "/abs/path", "Absolute unchanged")
})

console.log("\n📊 CONSTANTS TESTS\n")

test("Constants: Tool icons exist", () => {
  assert(constants.TOOL_ICONS["read"] === "📖", "Read icon")
  assert(constants.TOOL_ICONS["bash"] === "⚡", "Bash icon")
})

test("Constants: Git safe commands", () => {
  assert(constants.GIT_SAFE_COMMANDS.has("status"), "status is safe")
  assert(constants.GIT_SAFE_COMMANDS.has("log"), "log is safe")
  assert(!constants.GIT_SAFE_COMMANDS.has("push"), "push is not safe")
})

test("Constants: Git confirm commands", () => {
  assert(constants.GIT_CONFIRM_COMMANDS.has("push"), "push needs confirm")
  assert(constants.GIT_CONFIRM_COMMANDS.has("commit"), "commit needs confirm")
})

test("Constants: Supported file types", () => {
  assert(constants.TEXT_FILE_EXTENSIONS.has(".ts"), "TypeScript")
  assert(constants.TEXT_FILE_EXTENSIONS.has(".py"), "Python")
  assert(constants.TEXT_FILE_EXTENSIONS.has(".json"), "JSON")
})

console.log("\n⚡ SHELL TESTS\n")

test("Shell: Blocks dangerous commands", () => {
  assert(!shell.validateCommand("sudo apt install").allowed, "Blocks sudo")
  assert(!shell.validateCommand("rm -rf /").allowed, "Blocks rm -rf")
  assert(!shell.validateCommand("curl http://evil.com").allowed, "Blocks curl")
  assert(!shell.validateCommand("wget http://evil.com").allowed, "Blocks wget")
  assert(!shell.validateCommand("npm install").allowed, "Blocks npm")
  assert(!shell.validateCommand("pip install pkg").allowed, "Blocks pip")
})

test("Shell: Blocks shell operators", () => {
  assert(!shell.validateCommand("ls && rm file").allowed, "Blocks &&")
  assert(!shell.validateCommand("cat file | grep x").allowed, "Blocks |")
  assert(!shell.validateCommand("echo x > file").allowed, "Blocks >")
  assert(!shell.validateCommand("ls; rm file").allowed, "Blocks ;")
  assert(!shell.validateCommand("echo $(whoami)").allowed, "Blocks $()")
  assert(!shell.validateCommand("echo `whoami`").allowed, "Blocks backticks")
})

test("Shell: Allows safe commands", () => {
  assert(shell.validateCommand("ls -la").allowed, "Allows ls")
  assert(shell.validateCommand("cat file.txt").allowed, "Allows cat")
  assert(shell.validateCommand("git status").allowed, "Allows git status")
  assert(shell.validateCommand("pwd").allowed, "Allows pwd")
  assert(shell.validateCommand("head -n 10 file.txt").allowed, "Allows head")
  assert(shell.validateCommand("tail -f log.txt").allowed, "Allows tail")
  assert(shell.validateCommand("grep pattern file").allowed, "Allows grep")
  assert(shell.validateCommand("find . -name '*.ts'").allowed, "Allows find")
})

test("Shell: Parses commands correctly", () => {
  const parsed = shell.parseCommand("ls -la /tmp")
  assert(parsed !== null, "Should parse")
  assertEqual(parsed!.command, "ls", "Command")
  assertEqual(parsed!.args.length, 2, "Args count")
  assertEqual(parsed!.args[0], "-la", "First arg")
})

test("Shell: Formats blocked result", () => {
  const result: shell.ShellResult = { success: false, stdout: "", stderr: "", code: -1, blocked: true, reason: "Command blocked" }
  const formatted = shell.formatShellResult("sudo rm", result)
  assert(formatted.includes("🚫"), "Has blocked icon")
  assert(formatted.includes("Command blocked"), "Has reason")
})

test("Shell: Formats success result", () => {
  const result: shell.ShellResult = { success: true, stdout: "file.txt", stderr: "", code: 0 }
  const formatted = shell.formatShellResult("ls", result)
  assert(formatted.includes("✓"), "Has success icon")
  assert(formatted.includes("file.txt"), "Has output")
})

test("Shell: Formats error result", () => {
  const result: shell.ShellResult = { success: false, stdout: "", stderr: "not found", code: 1 }
  const formatted = shell.formatShellResult("cat missing", result)
  assert(formatted.includes("✗"), "Has error icon")
  assert(formatted.includes("not found"), "Has stderr")
  assert(formatted.includes("Exit code: 1"), "Has exit code")
})

console.log("\n" + "=".repeat(60))
console.log("\n📊 TEST SUMMARY\n")

const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed).length

console.log(`Total:  ${results.length}`)
console.log(`Passed: ${passed}`)
console.log(`Failed: ${failed}`)

if (failed > 0) {
  console.log("\n❌ Failed Tests:")
  results.filter(r => !r.passed).forEach(r => console.log(`  - ${r.name}: ${r.error}`))
  db.closeDb()
  process.exit(1)
}

console.log("\n✅ All tests passed!")
db.closeDb()
