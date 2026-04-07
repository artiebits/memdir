import fs from "node:fs"

function readMemories(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} day${days !== 1 ? "s" : ""}`
  if (hours > 0) return `${hours} hour${hours !== 1 ? "s" : ""}`
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? "s" : ""}`
  return "moments"
}

function buildPrompt(
  memory: string,
  envContext?: string,
  lastActiveAt?: string,
): string {
  const sections: string[] = []

  const now = new Date()
  let temporalLine = `Current time: ${now.toISOString()}`
  if (lastActiveAt) {
    const gap = now.getTime() - new Date(lastActiveAt).getTime()
    temporalLine += `. This session was last active ${formatDuration(gap)} ago.`
  }
  sections.push(`## Time\n\n${temporalLine}`)

  sections.push(
    [
      "## Your memory system",
      "You are a persistent agent. Your memory survives across sessions — past conversations are indexed and searchable, and facts you choose to save persist indefinitely. Build up your memory over time so that future conversations have a complete picture of who the user is, how they like to collaborate, what behaviors to avoid or repeat, and the context behind the work they give you. What you save now will be present the next time you run.",
    ].join("\n"),
  )

  if (memory.trim()) {
    sections.push(`## Memory\n\n${memory.trim()}`)
  }

  if (envContext?.trim()) {
    sections.push(`## Project context (read-only)\n\n${envContext.trim()}`)
  }

  sections.push(
    [
      "## Types of memory",
      "",
      "There are several discrete types of memory you can save:",
      "",
      "<types>",
      "<type>",
      "  <name>user</name>",
      "  <description>The user's preferences, goals, responsibilities, and knowledge. Helps tailor future responses to their perspective. Avoid writing memories that could be viewed as a negative judgement.</description>",
      "  <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge.</when_to_save>",
      "</type>",
      "<type>",
      "  <name>feedback</name>",
      "  <description>Guidance the user has given about how to approach work — both what to avoid and what to keep doing. Record from failure AND success: confirmations are quieter than corrections — watch for them.</description>",
      "  <when_to_save>Any time the user corrects your approach OR confirms a non-obvious approach worked. Include *why* so edge cases can be judged later.</when_to_save>",
      "  <body_structure>Lead with the rule itself, then a **Why:** line and a **How to apply:** line.</body_structure>",
      "</type>",
      "<type>",
      "  <name>project</name>",
      "  <description>Ongoing work, goals, bugs, or decisions not derivable from the code or git history.</description>",
      "  <when_to_save>When you learn who is doing what, why, or by when. Convert relative dates to absolute dates when saving.</when_to_save>",
      "  <body_structure>Lead with the fact or decision, then a **Why:** line and a **How to apply:** line.</body_structure>",
      "</type>",
      "<type>",
      "  <name>reference</name>",
      "  <description>Pointers to where information can be found in external systems (dashboards, issue trackers, Slack channels).</description>",
      "  <when_to_save>When you learn about external resources and their purpose.</when_to_save>",
      "</type>",
      "</types>",
    ].join("\n"),
  )

  sections.push(
    [
      "## What NOT to save in memory",
      "",
      "- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
      "- Git history, recent changes, or who-changed-what.",
      "- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
      "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
      "",
      "These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.",
    ].join("\n"),
  )

  sections.push(
    [
      "## When to access memories",
      "- When memories seem relevant, or the user references prior-conversation work.",
      "- If the user says to *ignore* or *not use* memory: proceed as if memory were empty. Do not apply remembered facts, cite, compare against, or mention memory content.",
      "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering based solely on a memory, verify it is still correct. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory.",
    ].join("\n"),
  )

  sections.push(
    [
      "## Before recommending from memory",
      "",
      "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed or removed. Before recommending it:",
      "",
      "- If the memory names a file path: check the file exists.",
      "- If the memory names a function or flag: grep for it.",
      "- If the user is about to act on your recommendation (not just asking about history), verify first.",
      "",
      '"The memory says X exists" is not the same as "X exists now."',
      "",
      "A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer reading the code or running git log over recalling the snapshot.",
    ].join("\n"),
  )

  sections.push(
    [
      "## Memory tools",
      "- Use memory_write proactively — do not wait for the user to ask.",
      "- Use memory_delete to remove a memory that is no longer relevant — pass its ID number from the Memory section.",
    ].join("\n"),
  )

  return sections.join("\n\n")
}

export async function loadMemoryPrompt(
  memoryFilePath: string,
  envContext?: string,
  lastActiveAt?: string,
): Promise<string> {
  const memories = readMemories(memoryFilePath)
  const memory = memories.map((m, i) => `[${i + 1}] ${m}`).join("\n\n")
  return buildPrompt(memory, envContext, lastActiveAt)
}
