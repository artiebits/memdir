import fs from "fs"
import path from "path"
import { createHash } from "crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EmbedFn = (text: string) => Promise<number[]>
type BatchEmbedFn = (texts: string[]) => Promise<number[][]>

export type Message = { role: string; content: string }

type LogEntry = { ts: string; user: string; assistant: string }

type IndexEntry = {
  id: string
  text: string
  date?: string
  source: "log" | "memory"
  embedding?: number[]
}

export type InitResult = { memoryPrompt: string; tools: object[] }

export type FlushOptions = {
  charThreshold?: number
  maxHistory?: number
  basePrompt?: string
}

export type MemoryOptions = { dir?: string }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLUSH_CHAR_THRESHOLD = 24_000
const FLUSH_MAX_HISTORY = 50
const LOG_LOOKBACK_DAYS = 30

// ---------------------------------------------------------------------------
// WriteQueue — serialises async mutations on a single promise chain
// ---------------------------------------------------------------------------

class WriteQueue {
  #tail = Promise.resolve()

  run(fn: () => Promise<void>): Promise<void> {
    const op = this.#tail.then(fn)
    this.#tail = op.catch((err: Error) => {
      console.error("[WriteQueue]", err.message)
    })
    return op
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

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

/**
 * Atomic write: write to .tmp then rename into place.
 * Falls back gracefully on Windows cross-device rename (EXDEV).
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.promises.writeFile(tmp, content, "utf-8")
  try {
    await fs.promises.rename(tmp, filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
    await fs.promises.writeFile(filePath, content, "utf-8")
    await fs.promises.unlink(tmp).catch(() => {})
  }
}

async function readSafe(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw err
  }
}

function parseJsonl<T>(text: string): T[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        console.warn("[memory] skipping malformed line:", line.slice(0, 80))
        return []
      }
    })
}

function dateStr(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

function assertEmbedding(embedding: unknown): number[] {
  if (!Array.isArray(embedding)) {
    throw new Error("embedding function must return a number[]")
  }
  return embedding as number[]
}

function resolveEmbed(embed: EmbedFn): BatchEmbedFn {
  if (typeof embed !== "function") {
    throw new TypeError("init() requires an embedFn: async (text) => number[]")
  }
  return async (texts) =>
    Promise.all(texts.map(async (text) => assertEmbedding(await embed(text))))
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export class Memory {
  readonly #dir: string
  readonly #memoryFile: string

  #embed: BatchEmbedFn | null = null
  #index: IndexEntry[] = []

  #queue = new WriteQueue()
  #indexQueue = new WriteQueue()

  constructor({ dir = "./memory" }: MemoryOptions = {}) {
    this.#dir = path.resolve(dir)
    this.#memoryFile = path.join(this.#dir, "memory.md")
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async init(embedFn: EmbedFn): Promise<InitResult> {
    this.#embed = resolveEmbed(embedFn)

    await fs.promises.mkdir(this.#dir, { recursive: true })
    await this.reindex()

    const memory = await this.#readMemory()
    return {
      memoryPrompt: this.#buildSystemContent(memory),
      tools: this.#buildTools(),
    }
  }

  async appendLog(
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    this.#embedder // guard

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      user: userContent,
      assistant: assistantContent,
    }
    const file = path.join(this.#dir, `${dateStr()}.jsonl`)

    await this.#queue.run(() =>
      fs.promises.appendFile(file, JSON.stringify(entry) + "\n", "utf-8"),
    )
  }

  async afterTurn(messages: Message[]): Promise<Message[]> {
    this.#embedder // guard

    const exchange = this.#latestExchange(messages)
    if (exchange) {
      await this.appendLog(exchange.user, exchange.assistant)
    }

    return (await this.maybeFlush(messages)) ?? messages
  }

  async reindex(): Promise<void> {
    this.#embedder // guard

    const [logChunks, memoryChunks] = await Promise.all([
      this.#collectLogChunks(),
      this.#collectMemoryChunks(),
    ])

    const unique = [
      ...new Map(
        [...memoryChunks, ...logChunks].map((entry) => [entry.id, entry]),
      ).values(),
    ]

    await this.#indexQueue.run(async () => {
      if (unique.length === 0) {
        this.#index = []
        return
      }

      const embeddings = await this.#embedder(unique.map((entry) => entry.text))
      this.#index = unique.map((entry, i) => ({
        ...entry,
        embedding: embeddings[i],
      }))
    })
  }

  async maybeFlush(
    messages: Message[],
    {
      charThreshold = FLUSH_CHAR_THRESHOLD,
      maxHistory = FLUSH_MAX_HISTORY,
      basePrompt = "",
    }: FlushOptions = {},
  ): Promise<Message[] | null> {
    this.#embedder // guard

    if (messages.length === 0) return null

    const totalChars = messages.reduce(
      (n, m) => n + (m.content?.length ?? 0),
      0,
    )
    if (totalChars < charThreshold) return null

    const memory = await this.#readMemory()
    const memoryPrompt = this.#buildSystemContent(memory)
    const systemContent = [basePrompt, memoryPrompt]
      .filter(Boolean)
      .join("\n\n")
    const system = { ...messages[0], content: systemContent }
    const rest = messages.slice(1)
    const tail = maxHistory > 1 ? rest.slice(-(maxHistory - 1)) : []

    return [system, ...tail]
  }

  // -------------------------------------------------------------------------
  // Private: embedder guard
  // -------------------------------------------------------------------------

  get #embedder(): BatchEmbedFn {
    if (!this.#embed) {
      throw new Error("Memory not initialised — call init() first")
    }
    return this.#embed
  }

  // -------------------------------------------------------------------------
  // Private: memory.md
  // -------------------------------------------------------------------------

  #readMemory(): Promise<string> {
    return readSafe(this.#memoryFile)
  }

  async #writeMemory(content: string): Promise<void> {
    const bullet = content.trim().startsWith("-")
      ? content.trim()
      : `- ${content.trim()}`

    await this.#queue.run(async () => {
      const existing = await this.#readMemory()
      const updated = existing
        ? `${existing.trimEnd()}\n${bullet}\n`
        : `${bullet}\n`
      await atomicWrite(this.#memoryFile, updated)
    })

    await this.#indexText(bullet, "memory")
  }

  async #deleteMemory(content: string): Promise<string> {
    const needle = content.trim().startsWith("-") ? content.trim() : `- ${content.trim()}`
    const id = sha256(needle)
    const exists = this.#index.some((e) => e.id === id && e.source === "memory")
    if (!exists) return "No matching memory found. Use memory_search to find the exact text first."

    await this.#queue.run(async () => {
      const existing = await this.#readMemory()
      const updated = existing
        .split("\n")
        .filter((line) => line.trim() !== needle)
        .join("\n")
        .trimEnd()
      await atomicWrite(this.#memoryFile, updated ? updated + "\n" : "")
    })

    this.#index = this.#index.filter((e) => e.id !== id)
    return `Deleted: ${needle}`
  }

  // -------------------------------------------------------------------------
  // Private: log helpers
  // -------------------------------------------------------------------------

  #logEntryToText({ ts, user, assistant }: LogEntry): string {
    return `[${ts}] user: ${user}\n[${ts}] assistant: ${assistant}`
  }

  #latestExchange(
    messages: Message[],
  ): { user: string; assistant: string } | null {
    let assistant: string | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]

      if (
        assistant === null &&
        message?.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.trim()
      ) {
        assistant = message.content
        continue
      }

      if (
        assistant !== null &&
        message?.role === "user" &&
        typeof message.content === "string" &&
        message.content.trim()
      ) {
        return { user: message.content, assistant }
      }
    }

    return null
  }

  async #collectLogChunks(): Promise<
    Array<{ text: string; id: string; date: string; source: "log" }>
  > {
    let files: string[]
    try {
      files = await fs.promises.readdir(this.#dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }

    const chunks = await Promise.all(
      files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .filter((f) => f.replace(".jsonl", "") >= dateStr(-LOG_LOOKBACK_DAYS))
        .map(async (file) => {
          const date = file.replace(".jsonl", "")
          const content = await readSafe(path.join(this.#dir, file))
          return parseJsonl<Record<string, unknown>>(content).flatMap(
            (entry) => {
              if (
                typeof entry?.ts !== "string" ||
                typeof entry?.user !== "string" ||
                typeof entry?.assistant !== "string"
              ) {
                return []
              }
              const logEntry: LogEntry = {
                ts: entry.ts,
                user: entry.user,
                assistant: entry.assistant,
              }
              const text = this.#logEntryToText(logEntry)
              return [{ text, id: sha256(text), date, source: "log" as const }]
            },
          )
        }),
    )
    return chunks.flat()
  }

  async #collectMemoryChunks(): Promise<
    Array<{ text: string; id: string; source: "memory" }>
  > {
    const content = await this.#readMemory()
    return content
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .map((bullet) => ({
        text: bullet.trim(),
        id: sha256(bullet.trim()),
        source: "memory" as const,
      }))
  }

  async #indexText(
    text: string,
    source: "log" | "memory",
    date?: string,
  ): Promise<void> {
    await this.#indexQueue.run(async () => {
      const id = sha256(text)
      if (this.#index.some((entry) => entry.id === id)) return

      const [embedding] = await this.#embedder([text])
      this.#index = [...this.#index, { id, text, date, source, embedding }]
    })
  }

  // -------------------------------------------------------------------------
  // Private: system prompt
  // -------------------------------------------------------------------------

  #buildSystemContent(memory: string): string {
    const memorySection = memory
      ? `## Profile Memory\n\n${memory}\n\nProfile memory contains only stable facts across conversations. Do not surface it unless directly relevant to the current reply.`
      : null

    const whenToAccess = [
      "## When to access memories",
      "- When memories seem relevant, or the user references prior-conversation work.",
      "- You MUST use memory_search when the user explicitly asks you to check, recall, or remember.",
      "- If the user says to ignore or not use memory: proceed as if memory were empty. Do not apply remembered facts, cite, compare against, or mention memory content.",
      "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering based solely on a memory, verify it is still correct. If a recalled memory conflicts with what you observe now, trust what you observe — and update or remove the stale memory.",
    ].join("\n")

    const beforeRecommending = [
      "## Before recommending from memory",
      "A memory that names a specific function, file, or flag is a claim that it existed when the memory was written. It may have been renamed, removed, or never merged. Before recommending it:",
      "- If the user is about to act on your recommendation (not just asking about history), verify first.",
      '"The memory says X exists" is not the same as "X exists now."',
    ].join("\n")

    const whenToSave = [
      "## When to save memories",
      "Save immediately when you learn something worth remembering — do not wait for the user to ask. Save when:",
      "- You learn details about the user's role, preferences, responsibilities, or knowledge",
      "- The user corrects your approach or confirms a non-obvious approach worked — include why, so edge cases can be judged later",
      "- You learn about ongoing work, goals, or deadlines not derivable from the conversation",
      "- The user explicitly asks you to remember something",
      "Do not save:",
      "- Ephemeral details: in-progress work, temporary state, or summaries of the current turn",
      "- Guesses, assumptions, or one-off topics",
    ].join("\n")

    return [memorySection, whenToSave, whenToAccess, beforeRecommending]
      .filter(Boolean)
      .join("\n\n")
  }

  // -------------------------------------------------------------------------
  // Private: tools
  // -------------------------------------------------------------------------

  #buildTools(): object[] {
    return [
      {
        name: "memory_write",
        description: "Save a fact about the user that is worth remembering.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                'A single concise sentence. State only what was explicitly said — no inference, no editorializing. For behavioral guidance, add the reason after a dash: "Prefers concise responses — finds long explanations condescending."',
            },
          },
          required: ["content"],
        },
        function: async ({ content }: { content: string }) => {
          await this.#writeMemory(content)
          return "Memory saved."
        },
      },
      {
        name: "memory_delete",
        description:
          "Delete a saved memory by its exact text. " +
          "Always call memory_search first to find the exact text of the memory to delete, " +
          "then pass that text here. Deletes only from long-term memory (memory.md), not from conversation logs.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The exact text of the memory to delete, as returned by memory_search.",
            },
          },
          required: ["content"],
        },
        function: async ({ content }: { content: string }) => {
          return this.#deleteMemory(content)
        },
      },
      {
        name: "memory_search",
        description:
          "Search past conversations and stored facts by semantic similarity. " +
          "Call this only when the current message likely depends on prior context — " +
          "for example the user refers to a past conversation, an ongoing project, a saved " +
          "preference, or an unresolved task. Do not call it for greetings, acknowledgements, " +
          "or standalone factual questions.",
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
        },
        function: async ({ query, k = 5 }: { query: string; k?: number }) => {
          if (this.#index.length === 0) return "No history indexed yet."

          const [queryEmbedding] = await this.#embedder([query])
          const safeK = Math.min(Math.max(1, k), 20)

          const results = this.#index
            .filter((e) => e.embedding?.length)
            .map((e) => ({
              ...e,
              score: cosineSim(queryEmbedding, e.embedding!),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, safeK)

          if (results.length === 0) return "No relevant history found."

          return results
            .map((e) =>
              e.date
                ? `[${e.source} / ${e.date}]\n${e.text}`
                : `[${e.source}]\n${e.text}`,
            )
            .join("\n\n---\n\n")
        },
      },
    ]
  }
}
