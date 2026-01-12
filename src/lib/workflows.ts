import type { TaskWorkflow, AgentMode } from "./types.js"

export const BUILTIN_WORKFLOWS: TaskWorkflow[] = [
  {
    id: "debug-error",
    name: "Debug Error",
    icon: "🐛",
    description: "Analyze and fix an error",
    prompt: "I have an error that needs debugging. Please analyze it and suggest fixes.",
    mode: "build",
  },
  {
    id: "review-diff",
    name: "Review Diff",
    icon: "🔍",
    description: "Review current git changes",
    prompt: "Please review the current git diff and provide feedback on code quality, potential issues, and suggestions.",
    mode: "plan",
  },
  {
    id: "refactor-file",
    name: "Refactor File",
    icon: "♻️",
    description: "Improve code structure",
    prompt: "Please analyze and refactor this code to improve readability, maintainability, and performance.",
    mode: "build",
  },
  {
    id: "write-tests",
    name: "Write Tests",
    icon: "🧪",
    description: "Generate test cases",
    prompt: "Please write comprehensive test cases for this code, covering edge cases and error scenarios.",
    mode: "build",
  },
  {
    id: "release-notes",
    name: "Release Notes",
    icon: "📝",
    description: "Generate release notes from commits",
    prompt: "Please analyze the recent commits and generate release notes summarizing the changes.",
    mode: "plan",
  },
  {
    id: "explain-code",
    name: "Explain Code",
    icon: "📖",
    description: "Get detailed code explanation",
    prompt: "Please provide a detailed explanation of this code, including its purpose, how it works, and any notable patterns.",
    mode: "plan",
  },
  {
    id: "security-review",
    name: "Security Review",
    icon: "🔒",
    description: "Check for security issues",
    prompt: "Please perform a security review of this code, identifying potential vulnerabilities and suggesting fixes.",
    mode: "plan",
  },
  {
    id: "optimize-perf",
    name: "Optimize Performance",
    icon: "⚡",
    description: "Find and fix performance issues",
    prompt: "Please analyze this code for performance bottlenecks and suggest optimizations.",
    mode: "build",
  },
]

export function getWorkflow(id: string): TaskWorkflow | undefined {
  return BUILTIN_WORKFLOWS.find(w => w.id === id)
}

export function getWorkflowPrompt(workflow: TaskWorkflow, userContext?: string): string {
  if (userContext) {
    return `${workflow.prompt}\n\nContext:\n${userContext}`
  }
  return workflow.prompt
}

export function getWorkflowMode(workflow: TaskWorkflow): AgentMode {
  return workflow.mode ?? "build"
}
