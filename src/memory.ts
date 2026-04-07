import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { tool, type AgentInputItem } from "@openai/agents"
import {
  WriteQueue,
  atomicWrite,
  atomicAppend,
  readSafe,
  parseJsonl,
} from "./fs-utils.js"
import { listSessions, readSessionItems } from "./session.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentPart {
  type: string
  text?: string
}

interface Exchange {
  user: string
  assistant: string
}

interface IndexChunk {
  id: string
  text: string
  source: "session"
  sessionId: string
}

interface IndexEntry extends IndexChunk {
  embedding: number[]
}

type Embedder = (text: string) => Promise<number[]>

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let _dir: string
let _index: IndexEntry[] = []
let _embed: Promise<Embedder> | null = null
let _pendingTurns: IndexChunk[] = []
let _turnCounter = 0
const _queue = new WriteQueue()
const _indexQueue = new WriteQueue()

const MEMORY_FILE = "MEMORY.md"
const INDEX_FILE = "index.jsonl"
const FLUSH_AFTER_TURNS = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function cosineSim(a: number[], b: number[]): number {
  let dot = 0,
    ma = 0,
    mb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    ma += a[i] * a[i]
    mb += b[i] * b[i]
  }
  return ma === 0 || mb === 0 ? 0 : dot / (Math.sqrt(ma) * Math.sqrt(mb))
}

// ---------------------------------------------------------------------------
// Embedder — lazy singleton
// ---------------------------------------------------------------------------

function getEmbed(): Promise<Embedder> {
  if (!_embed) {
    _embed = (async () => {
      const { pipeline } = await import("@huggingface/transformers")
      const pipe = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
      )
      return async (text: string) => {
        const output = await pipe(text, { pooling: "mean", normalize: true })
        return Array.from(output.data as number[])
      }
    })()
  }
  return _embed
}

// ---------------------------------------------------------------------------
// AgentInputItem helpers
// ---------------------------------------------------------------------------

function extractText(item: AgentInputItem): string | null {
  const content = (item as { content?: unknown }).content
  if (!content) return null
  if (typeof content === "string") return content.trim() || null
  if (Array.isArray(content)) {
    const text = (content as ContentPart[])
      .filter((c) => c.type === "input_text" || c.type === "output_text")
      .map((c) => c.text ?? "")
      .join(" ")
      .trim()
    return text || null
  }
  return null
}

function latestExchange(items: AgentInputItem[]): Exchange | null {
  let assistant: string | null = null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    const text = extractText(item)
    if (!text) continue
    const role = (item as { role?: string }).role
    if (assistant === null && role === "assistant") {
      assistant = text
    } else if (assistant !== null && role === "user") {
      return { user: text, assistant }
    }
  }
  return null
}

function extractExchanges(items: AgentInputItem[]): Exchange[] {
  const exchanges: Exchange[] = []
  let pendingUser: string | null = null
  for (const item of items) {
    const text = extractText(item)
    if (!text) continue
    const role = (item as { role?: string }).role
    if (role === "user") {
      pendingUser = text
    } else if (role === "assistant" && pendingUser) {
      exchanges.push({ user: pendingUser, assistant: text })
      pendingUser = null
    }
  }
  return exchanges
}

// ---------------------------------------------------------------------------
// Index persistence
// ---------------------------------------------------------------------------

async function loadIndexFromDisk(): Promise<void> {
  const text = await readSafe(path.join(_dir, INDEX_FILE))
  if (!text) return
  _index = (parseJsonl(text) as Partial<IndexEntry>[]).filter(
    (e): e is IndexEntry => Array.isArray(e.embedding) && e.embedding.length > 0,
  )
}

async function appendIndexFile(entries: IndexEntry[]): Promise<void> {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  await atomicAppend(path.join(_dir, INDEX_FILE), lines)
}

async function rewriteIndexFile(): Promise<void> {
  const lines = _index.map((e) => JSON.stringify(e)).join("\n")
  await atomicWrite(
    path.join(_dir, INDEX_FILE),
    lines ? lines + "\n" : "",
  )
}

// ---------------------------------------------------------------------------
// Index operations
// ---------------------------------------------------------------------------

async function flushPendingTurns(): Promise<void> {
  const batch = _pendingTurns.splice(0)
  _turnCounter = 0
  await _indexQueue.run(async () => {
    const existingIds = new Set(_index.map((e) => e.id))
    const newChunks = batch.filter((e) => !existingIds.has(e.id))
    if (newChunks.length === 0) return
    const embed = await getEmbed()
    const embeddings = await Promise.all(newChunks.map((e) => embed(e.text)))
    const newEntries: IndexEntry[] = newChunks.map((e, i) => ({
      ...e,
      embedding: embeddings[i],
    }))
    _index = [..._index, ...newEntries]
    await appendIndexFile(newEntries)
  })
}

async function reindex(): Promise<void> {
  const sessions = await listSessions(_dir)

  const sessionChunks = (
    await Promise.all(
      sessions.map(async ({ id }) => {
        const items = await readSessionItems(_dir, id)
        return extractExchanges(items).map((ex): IndexChunk => {
          const text = `user: ${ex.user}\nassistant: ${ex.assistant}`
          return { id: sha256(text), text, source: "session", sessionId: id }
        })
      }),
    )
  ).flat()

  const unique = [...new Map(sessionChunks.map((e) => [e.id, e])).values()]

  await _indexQueue.run(async () => {
    // Embed only entries not already in the index
    const existingIds = new Set(_index.map((e) => e.id))
    const newChunks = unique.filter((e) => !existingIds.has(e.id))

    if (newChunks.length === 0) return

    const embed = await getEmbed()
    const embeddings = await Promise.all(newChunks.map((e) => embed(e.text)))
    const newEntries: IndexEntry[] = newChunks.map((e, i) => ({
      ...e,
      embedding: embeddings[i],
    }))
    _index = [..._index, ...newEntries]
    await appendIndexFile(newEntries)
  })
}

// ---------------------------------------------------------------------------
// MEMORY.md operations
// ---------------------------------------------------------------------------

async function writeMemory(content: string): Promise<string> {
  const bullet = content.trim().startsWith("-")
    ? content.trim()
    : `- ${content.trim()}`
  await _queue.run(async () => {
    const existing = await readSafe(path.join(_dir, MEMORY_FILE))
    const updated = existing
      ? `${existing.trimEnd()}\n${bullet}\n`
      : `${bullet}\n`
    await atomicWrite(path.join(_dir, MEMORY_FILE), updated)
  })
  return "Memory saved."
}

async function deleteMemory(content: string): Promise<string> {
  const needle = content.trim().startsWith("-")
    ? content.trim()
    : `- ${content.trim()}`
  let deleted = false
  await _queue.run(async () => {
    const existing = await readSafe(path.join(_dir, MEMORY_FILE))
    const lines = existing.split("\n")
    const filtered = lines.filter((l) => l.trim() !== needle)
    if (filtered.length === lines.length) return
    deleted = true
    const updated = filtered.join("\n").trimEnd()
    await atomicWrite(
      path.join(_dir, MEMORY_FILE),
      updated ? `${updated}\n` : "",
    )
  })
  return deleted
    ? `Deleted: ${needle}`
    : "No matching memory found. The text must match exactly as it appears in the Memory section."
}

async function replaceMemory(oldContent: string, newContent: string): Promise<string> {
  const oldLine = oldContent.trim().startsWith("-") ? oldContent.trim() : `- ${oldContent.trim()}`
  const newLine = newContent.trim().startsWith("-") ? newContent.trim() : `- ${newContent.trim()}`
  let replaced = false
  await _queue.run(async () => {
    const existing = await readSafe(path.join(_dir, MEMORY_FILE))
    const lines = existing.split("\n")
    const updated = lines.map((l) => {
      if (l.trim() === oldLine) {
        replaced = true
        return newLine
      }
      return l
    })
    if (!replaced) return
    await atomicWrite(path.join(_dir, MEMORY_FILE), updated.join("\n").trimEnd() + "\n")
  })
  return replaced
    ? `Replaced: ${oldLine} → ${newLine}`
    : "No matching memory found. The text must match exactly as it appears in the Memory section."
}

async function searchMemory(query: string, k = 5): Promise<string> {
  if (_index.length === 0) return "No history indexed yet."
  const embed = await getEmbed()
  const queryEmbedding = await embed(query)
  const safeK = Math.min(Math.max(1, k), 20)
  const results = _index
    .filter((e) => e.embedding?.length)
    .map((e) => ({ ...e, score: cosineSim(queryEmbedding, e.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, safeK)
  if (results.length === 0) return "No relevant history found."
  return results.map((e) => `[${e.source}]\n${e.text}`).join("\n\n---\n\n")
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildPrompt(memory: string, envContext?: string): string {
  const sections: string[] = []

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
      "  <description>The user's role, goals, responsibilities, and knowledge. Helps tailor future responses to their perspective. Avoid writing memories that could be viewed as a negative judgement.</description>",
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
      "- You MUST call memory_search when the user explicitly asks you to check, recall, or remember.",
      "- If the user says to *ignore* or *not use* memory: proceed as if memory were empty. Do not apply remembered facts, cite, compare against, or mention memory content.",
      "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering based solely on a memory, verify it is still correct. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory.",
    ].join("\n"),
  )

  sections.push(
    [
      "## Before recommending from memory",
      "",
      "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
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
      "- Use memory_write proactively — do not wait for the user to ask. Save when you learn details about the user's role, preferences, responsibilities, or knowledge; when the user corrects your approach or confirms a non-obvious approach worked; when you learn who is doing what, why, or by when; or when you learn about external resources and their purpose.",
      "- Use memory_search to recall past context. Call it when the user references prior work, preferences, or asks you to remember something.",
      "- Use memory_replace to correct a memory that is wrong or outdated — pass the exact old text and the new text. Prefer this over delete + write.",
      "- Use memory_delete to remove a memory that is no longer relevant — copy the exact text from your Memory section above.",
    ].join("\n"),
  )

  return sections.join("\n\n")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadMemoryPrompt(dir: string, envContext?: string): Promise<string> {
  _dir = dir
  await fs.promises.mkdir(_dir, { recursive: true })
  await loadIndexFromDisk()
  reindex()
  const memory = await readSafe(path.join(_dir, MEMORY_FILE))
  return buildPrompt(memory, envContext)
}

export function indexTurn(items: AgentInputItem[], sessionId: string): void {
  const exchange = latestExchange(items)
  if (!exchange) return
  const text = `user: ${exchange.user}\nassistant: ${exchange.assistant}`
  _pendingTurns.push({ id: sha256(text), text, source: "session", sessionId })
  _turnCounter++
  if (_turnCounter >= FLUSH_AFTER_TURNS) flushPendingTurns()
}

export async function clearSessionIndex(sessionId: string): Promise<void> {
  await _indexQueue.run(async () => {
    _index = _index.filter(
      (e) => e.source !== "session" || e.sessionId !== sessionId,
    )
    await rewriteIndexFile()
  })
}

export function getMemoryTools(dir: string) {
  _dir = dir
  return [
    tool({
      name: "memory_write",
      description: "Save a fact worth remembering across sessions.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "A single concise sentence describing the fact to save.",
          },
        },
        required: ["content"],
        additionalProperties: true,
      },
      strict: false,
      execute: async (input) => {
        const { content } = input as { content: string }
        return writeMemory(content)
      },
    }),
    tool({
      name: "memory_delete",
      description:
        "Delete a saved memory by its exact text. The exact text is visible in your Memory section above — copy it directly from there.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The exact text of the memory to delete, as it appears in the Memory section of your system prompt.",
          },
        },
        required: ["content"],
        additionalProperties: true,
      },
      strict: false,
      execute: async (input) => {
        const { content } = input as { content: string }
        return deleteMemory(content)
      },
    }),
    tool({
      name: "memory_replace",
      description:
        "Replace an existing memory with updated content. Use this to correct a memory that is wrong or outdated instead of deleting and rewriting it. The old_content must match exactly as it appears in the Memory section above.",
      parameters: {
        type: "object",
        properties: {
          old_content: {
            type: "string",
            description: "The text of the memory to replace, as it appears in the Memory section.",
          },
          new_content: {
            type: "string",
            description: "The updated text to replace it with.",
          },
        },
        required: ["old_content", "new_content"],
        additionalProperties: true,
      },
      strict: false,
      execute: async (input) => {
        const { old_content, new_content } = input as { old_content: string; new_content: string }
        return replaceMemory(old_content, new_content)
      },
    }),
    tool({
      name: "memory_search",
      description:
        "Search past conversations and saved facts by semantic similarity. Call when the user references prior work, preferences, or asks you to recall something.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language description of what you want to recall.",
          },
          k: {
            type: "number",
            description: "Number of results to return (default 5, max 20).",
          },
        },
        required: ["query"],
        additionalProperties: true,
      },
      strict: false,
      execute: async (input) => {
        const { query, k = 5 } = input as { query: string; k?: number }
        return searchMemory(query, k)
      },
    }),
  ]
}
