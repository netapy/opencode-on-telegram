import type { ExportOptions, ExportFormat, HistoryEntry } from "./types.js"
import { getSessionHistory } from "./db.js"
import { redactSecrets } from "./redact.js"

export function exportSession(
  sessionId: string,
  title: string,
  options: ExportOptions
): string {
  const entries = getSessionHistory(sessionId, 1000, 0).reverse()
  
  const filteredEntries = entries.filter(entry => {
    if (options.startTime && entry.timestamp < options.startTime) return false
    if (options.endTime && entry.timestamp > options.endTime) return false
    return true
  })
  
  switch (options.format) {
    case "json":
      return exportAsJson(title, filteredEntries, options)
    case "html":
      return exportAsHtml(title, filteredEntries, options)
    default:
      return exportAsMarkdown(title, filteredEntries, options)
  }
}

function processText(text: string, options: ExportOptions): string {
  return options.redactSecrets ? redactSecrets(text) : text
}

function exportAsMarkdown(
  title: string,
  entries: HistoryEntry[],
  options: ExportOptions
): string {
  const lines: string[] = [
    `# ${title}`,
    "",
    `Exported: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ]
  
  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleString()
    const role = entry.role === "user" ? "👤 User" : "🤖 Assistant"
    const text = processText(entry.text, options)
    
    lines.push(`### ${role} (${time})`)
    lines.push("")
    lines.push(text)
    
    if (options.includeToolOutputs && entry.toolNames?.length) {
      lines.push("")
      lines.push(`*Tools used: ${entry.toolNames.join(", ")}*`)
    }
    
    lines.push("")
    lines.push("---")
    lines.push("")
  }
  
  return lines.join("\n")
}

function exportAsJson(
  title: string,
  entries: HistoryEntry[],
  options: ExportOptions
): string {
  const data = {
    title,
    exportedAt: new Date().toISOString(),
    messages: entries.map(entry => ({
      role: entry.role,
      timestamp: entry.timestamp,
      text: processText(entry.text, options),
      tools: options.includeToolOutputs ? entry.toolNames : undefined,
    })),
  }
  
  return JSON.stringify(data, null, 2)
}

function exportAsHtml(
  title: string,
  entries: HistoryEntry[],
  options: ExportOptions
): string {
  const escapeHtml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  
  const messageHtml = entries.map(entry => {
    const time = new Date(entry.timestamp).toLocaleString()
    const roleClass = entry.role === "user" ? "user" : "assistant"
    const roleLabel = entry.role === "user" ? "User" : "Assistant"
    const text = escapeHtml(processText(entry.text, options))
    const tools = options.includeToolOutputs && entry.toolNames?.length
      ? `<div class="tools">Tools: ${entry.toolNames.join(", ")}</div>`
      : ""
    
    return `
      <div class="message ${roleClass}">
        <div class="header">${roleLabel} · ${time}</div>
        <div class="content">${text.replace(/\n/g, "<br>")}</div>
        ${tools}
      </div>
    `
  }).join("\n")
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 0 auto; padding: 20px; }
    .message { margin: 20px 0; padding: 15px; border-radius: 8px; }
    .user { background: #e3f2fd; }
    .assistant { background: #f5f5f5; }
    .header { font-weight: bold; margin-bottom: 10px; color: #666; }
    .content { white-space: pre-wrap; }
    .tools { margin-top: 10px; font-size: 0.9em; color: #888; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>Exported: ${new Date().toISOString()}</p>
  ${messageHtml}
</body>
</html>`
}

export function getExportFilename(title: string, format: ExportFormat): string {
  const safeName = title.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 50)
  const date = new Date().toISOString().slice(0, 10)
  const ext = format === "json" ? "json" : format === "html" ? "html" : "md"
  return `${safeName}-${date}.${ext}`
}
