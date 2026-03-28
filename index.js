/**
 * memdir — agent memory management
 *
 * Directory layout:
 *   memory/
 *     memory.md          — long-term facts (human-readable markdown bullets)
 *     YYYY-MM-DD.jsonl   — daily conversation logs (one JSON entry per line)
 *
 * Usage:
 *   const memory = new Memory()
 *   const { systemContent, tools } = await memory.init(agentPrompt, async (text) => await embed(text))
 *
 *   messages = await memory.afterTurn(messages)
 *
 * @typedef {(text: string) => Promise<number[]>} EmbedFn
 * @typedef {(texts: string[]) => Promise<number[][]>} BatchEmbedFn
 * @typedef {{ role: string, content: string }} Message
 * @typedef {{ id: string, text: string, date?: string, source: 'log'|'memory', embedding?: number[] }} IndexEntry
 * @typedef {{ systemContent: string, tools: object[] }} InitResult
 */

import fs from "fs"
import path from "path"
import { createHash } from "crypto"

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

  /** @param {() => Promise<void>} fn */
  run(fn) {
    const op = this.#tail.then(fn)
    this.#tail = op.catch((err) => {
      console.error("[WriteQueue]", err.message)
    })
    return op
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** @param {string} text @returns {string} */
const sha256 = (text) => createHash("sha256").update(text).digest("hex")

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSim(a, b) {
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
 * @param {string} filePath
 * @param {string} content
 */
async function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`
  await fs.promises.writeFile(tmp, content, "utf-8")
  try {
    await fs.promises.rename(tmp, filePath)
  } catch (err) {
    if (err.code !== "EXDEV") throw err
    await fs.promises.writeFile(filePath, content, "utf-8")
    await fs.promises.unlink(tmp).catch(() => {})
  }
}

/** @param {string} filePath @returns {Promise<string>} */
async function readSafe(filePath) {
  try {
    return await fs.promises.readFile(filePath, "utf-8")
  } catch (err) {
    if (err.code === "ENOENT") return ""
    throw err
  }
}

/**
 * Parse a JSONL string, skipping malformed lines with a warning.
 * @template T
 * @param {string} text
 * @returns {T[]}
 */
function parseJsonl(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        console.warn("[memory] skipping malformed line:", line.slice(0, 80))
        return []
      }
    })
}

/** @param {number} offsetDays @returns {string} YYYY-MM-DD */
function dateStr(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

/** @param {unknown} embedding @returns {number[]} */
function assertEmbedding(embedding) {
  if (!Array.isArray(embedding)) {
    throw new Error("embedding function must return a number[]")
  }
  return embedding
}

/** @param {EmbedFn} embed @returns {BatchEmbedFn} */
function resolveEmbed(embed) {
  if (typeof embed !== "function") {
    throw new TypeError("init() requires an embedFn: async (text) => number[]")
  }
  return async (texts) => Promise.all(texts.map(async (text) => assertEmbedding(await embed(text))))
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export class Memory {
  #dir
  #memoryFile // <dir>/memory.md

  /** @type {BatchEmbedFn|null} */
  #embed = null
  /** @type {IndexEntry[]} */
  #index = []

  #queue = new WriteQueue()
  #indexQueue = new WriteQueue()

  /** @param {{ dir?: string }} opts */
  constructor({ dir = "./memory" } = {}) {
    this.#dir = path.resolve(dir)
    this.#memoryFile = path.join(this.#dir, "memory.md")
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Initialise the manager. Must be called once before anything else.
   *
   * @param {EmbedFn} embedFn
   * @returns {Promise<{ memoryPrompt: string, tools: object[] }>}
   */
  async init(embedFn) {
    this.#embed = resolveEmbed(embedFn)

    await fs.promises.mkdir(this.#dir, { recursive: true })
    await this.reindex()

    const memory = await this.#readMemory()
    return {
      memoryPrompt: this.#buildSystemContent(memory),
      tools: this.#buildTools(),
    }
  }

  /**
   * Append one exchange to today's JSONL log.
   * Write is serialised through the queue, then the in-memory index is updated.
   * Throws on write or indexing failure — callers should handle.
   *
   * @param {string} userContent
   * @param {string} assistantContent
   */
  async appendLog(userContent, assistantContent) {
    this.#assertReady()

    const entry = {
      ts: new Date().toISOString(),
      user: userContent,
      assistant: assistantContent,
    }
    const file = path.join(this.#dir, `${dateStr()}.jsonl`)

    await this.#queue.run(() => fs.promises.appendFile(file, JSON.stringify(entry) + "\n", "utf-8"))

    await this.#indexText(this.#logEntryToText(entry), "log", dateStr())
  }

  /**
   * Convenience helper for completed turns. Logs the latest user/assistant pair
   * already present in messages, then flushes if needed.
   *
   * @param {Message[]} messages
   * @returns {Promise<Message[]>}
   */
  async afterTurn(messages) {
    this.#assertReady()

    const exchange = this.#latestExchange(messages)
    if (exchange) {
      await this.appendLog(exchange.user, exchange.assistant)
    }

    return (await this.maybeFlush(messages)) ?? messages
  }

  /**
   * Rebuild the in-memory index from memory.md and recent log files.
   */
  async reindex() {
    this.#assertReady()

    const [logChunks, memoryChunks] = await Promise.all([this.#collectLogChunks(), this.#collectMemoryChunks()])

    const unique = [...new Map([...memoryChunks, ...logChunks].map((entry) => [entry.id, entry])).values()]

    await this.#indexQueue.run(async () => {
      if (unique.length === 0) {
        this.#index = []
        return
      }

      const embeddings = await this.#embed(unique.map((entry) => entry.text))
      this.#index = unique.map((entry, i) => ({
        ...entry,
        embedding: embeddings[i],
      }))
    })
  }

  /**
   * Trim the conversation if it has grown past the char threshold, refreshing
   * the system message with the latest memory.
   *
   * Returns a new array when trimmed, null when no action was needed.
   * Usage: messages = await mm.maybeFlush(messages, { basePrompt }) ?? messages
   *
   * @param {Message[]} messages
   * @param {{ charThreshold?: number, maxHistory?: number, basePrompt?: string }} opts
   * @returns {Promise<Message[] | null>}
   */
  async maybeFlush(messages, { charThreshold = FLUSH_CHAR_THRESHOLD, maxHistory = FLUSH_MAX_HISTORY, basePrompt = '' } = {}) {
    this.#assertReady()

    if (messages.length === 0) return null

    const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
    if (totalChars < charThreshold) return null

    const memory = await this.#readMemory()
    const memoryPrompt = this.#buildSystemContent(memory)
    const systemContent = [basePrompt, memoryPrompt].filter(Boolean).join('\n\n')
    const system = { ...messages[0], content: systemContent }
    const rest = messages.slice(1)
    const tail = maxHistory > 1 ? rest.slice(-(maxHistory - 1)) : []

    return [system, ...tail]
  }

  // -------------------------------------------------------------------------
  // Private: memory.md
  // -------------------------------------------------------------------------

  /** @returns {Promise<string>} */
  #readMemory() {
    return readSafe(this.#memoryFile)
  }

  /**
   * Append a markdown bullet to memory.md and index it.
   * Read-modify-write is safe because all writes go through the queue.
   * @param {string} content
   */
  async #writeMemory(content) {
    const bullet = content.trim().startsWith("-") ? content.trim() : `- ${content.trim()}`

    await this.#queue.run(async () => {
      const existing = await this.#readMemory()
      const updated = existing ? `${existing.trimEnd()}\n${bullet}\n` : `${bullet}\n`
      await atomicWrite(this.#memoryFile, updated)
    })

    await this.#indexText(bullet, "memory")
  }

  // -------------------------------------------------------------------------
  // Private: log helpers
  // -------------------------------------------------------------------------

  /** @param {{ ts: string, user: string, assistant: string }} entry @returns {string} */
  #logEntryToText({ ts, user, assistant }) {
    return `[${ts}] user: ${user}\n[${ts}] assistant: ${assistant}`
  }

  /** @param {Message[]} messages @returns {{ user: string, assistant: string } | null} */
  #latestExchange(messages) {
    let assistant = null

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

  /** @returns {Promise<Array<{ text: string, id: string, date: string, source: 'log' }>>} */
  async #collectLogChunks() {
    let files
    try {
      files = await fs.promises.readdir(this.#dir)
    } catch (err) {
      if (err.code === "ENOENT") return []
      throw err
    }

    const chunks = await Promise.all(
      files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .filter((f) => f.replace(".jsonl", "") >= dateStr(-LOG_LOOKBACK_DAYS))
        .map(async (file) => {
          const date = file.replace(".jsonl", "")
          const content = await readSafe(path.join(this.#dir, file))
          return parseJsonl(content).flatMap((entry) => {
            if (
              typeof entry?.ts !== "string" ||
              typeof entry?.user !== "string" ||
              typeof entry?.assistant !== "string"
            ) {
              return []
            }
            const text = this.#logEntryToText(entry)
            return [{ text, id: sha256(text), date, source: /** @type {'log'} */ ("log") }]
          })
        }),
    )
    return chunks.flat()
  }

  /** @returns {Promise<Array<{ text: string, id: string, source: 'memory' }>>} */
  async #collectMemoryChunks() {
    const content = await this.#readMemory()
    return content
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .map((bullet) => ({
        text: bullet.trim(),
        id: sha256(bullet.trim()),
        source: /** @type {'memory'} */ ("memory"),
      }))
  }

  /**
   * Embed a single text and add it to the in-memory index if not already present.
   * @param {string} text
   * @param {'log'|'memory'} source
   * @param {string=} date
   */
  async #indexText(text, source, date) {
    await this.#indexQueue.run(async () => {
      const id = sha256(text)
      if (this.#index.some((entry) => entry.id === id)) return

      const [embedding] = await this.#embed([text])
      this.#index = [...this.#index, { id, text, date, source, embedding }]
    })
  }

  // -------------------------------------------------------------------------
  // Private: system prompt
  // -------------------------------------------------------------------------

  /** @param {string} memory @returns {string} */
  #buildSystemContent(memory) {
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

  /** @returns {object[]} */
  #buildTools() {
    return [
      {
        name: "memory_write",
        description: "Save a fact about the user that is worth remembering.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "A single concise sentence. State only what was explicitly said — no inference, no editorializing. For behavioral guidance, add the reason after a dash: \"Prefers concise responses — finds long explanations condescending.\"",
            },
          },
          required: ["content"],
        },
        function: async ({ content }) => {
          await this.#writeMemory(content)
          return "Memory saved."
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
              description: "Natural language description of what you want to recall.",
            },
            k: {
              type: "number",
              description: "Number of results to return (default 5, max 20).",
            },
          },
          required: ["query"],
        },
        function: async ({ query, k = 5 }) => {
          if (this.#index.length === 0) return "No history indexed yet."

          const [queryEmbedding] = await this.#embed([query])
          const safeK = Math.min(Math.max(1, k), 20)

          const results = this.#index
            .filter((e) => e.embedding?.length)
            .map((e) => ({ ...e, score: cosineSim(queryEmbedding, e.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, safeK)

          if (results.length === 0) return "No relevant history found."

          return results
            .map((e) => (e.date ? `[${e.source} / ${e.date}]\n${e.text}` : `[${e.source}]\n${e.text}`))
            .join("\n\n---\n\n")
        },
      },
    ]
  }

  // -------------------------------------------------------------------------
  // Private: guard
  // -------------------------------------------------------------------------

  #assertReady() {
    if (!this.#embed) {
      throw new Error("Memory not initialised — call init() first")
    }
  }
}
