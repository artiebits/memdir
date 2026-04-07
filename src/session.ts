import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { MemorySession as SDKMemorySession, type AgentInputItem } from "@openai/agents"
import {
  WriteQueue,
  atomicWrite,
  atomicAppend,
  readSafe,
  parseJsonl,
} from "./fs-utils.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionEntry {
  id: string
  createdAt: string
  lastActiveAt: string
}

interface SessionData {
  current: string | null
  sessions: SessionEntry[]
}

interface CompactionMarker {
  type: "compaction_marker"
  timestamp: string
  summary: string
  keptSince?: string
  retainCount: number
}

type PersistedItem = (AgentInputItem & { _savedAt?: string }) | CompactionMarker

interface ContentPart {
  type: string
  text?: string
}

// ---------------------------------------------------------------------------
// SessionIndex — owns sessions.json
// ---------------------------------------------------------------------------

class SessionIndex {
  #dir: string
  #queue = new WriteQueue()

  constructor(dir: string) {
    this.#dir = dir
  }

  get #indexPath(): string {
    return path.join(this.#dir, "sessions.json")
  }

  async #ensureDir(): Promise<void> {
    await fs.promises.mkdir(this.#dir, { recursive: true })
  }

  async read(): Promise<SessionData> {
    await this.#ensureDir()
    const text = await readSafe(this.#indexPath)
    if (text) {
      try {
        return JSON.parse(text) as SessionData
      } catch {
        // corrupt file — fall through to bootstrap
      }
    }

    // sessions.json absent or corrupt — try bootstrapping from existing files
    const bootstrapped = await this.#bootstrap()
    if (bootstrapped) return this.read()

    return { current: null, sessions: [] }
  }

  async #bootstrap(): Promise<boolean> {
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(this.#dir, { withFileTypes: true })
    } catch {
      return false
    }

    const sessionFiles = dirents.filter(
      (d) => d.isFile() && /^session-[0-9a-f-]+\.jsonl$/.test(d.name),
    )
    if (sessionFiles.length === 0) return false

    const entries = await Promise.all(
      sessionFiles.map(async (d) => {
        const id = d.name.replace(/^session-/, "").replace(/\.jsonl$/, "")
        const fp = path.join(this.#dir, d.name)
        const { mtimeMs, birthtimeMs } = await fs.promises.stat(fp)
        return {
          id,
          createdAt: new Date(birthtimeMs).toISOString(),
          lastActiveAt: new Date(mtimeMs).toISOString(),
        }
      }),
    )

    entries.sort(
      (a, b) =>
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
    )
    const data: SessionData = { current: entries[0].id, sessions: entries }
    await atomicWrite(this.#indexPath, JSON.stringify(data, null, 2) + "\n")
    return true
  }

  async currentSessionId(): Promise<string | null> {
    const data = await this.read()
    return data.current ?? null
  }

  async create(sessionId: string): Promise<void> {
    await this.#queue.run(async () => {
      await this.#ensureDir()
      const data = await this.read()
      const now = new Date().toISOString()
      data.sessions.push({ id: sessionId, createdAt: now, lastActiveAt: now })
      data.current = sessionId
      await atomicWrite(this.#indexPath, JSON.stringify(data, null, 2) + "\n")
    })
  }

  async activate(sessionId: string): Promise<void> {
    await this.#queue.run(async () => {
      await this.#ensureDir()
      const data = await this.read()
      const exists = data.sessions.some((s) => s.id === sessionId)
      if (!exists) {
        const now = new Date().toISOString()
        data.sessions.push({ id: sessionId, createdAt: now, lastActiveAt: now })
      }
      data.current = sessionId
      await atomicWrite(this.#indexPath, JSON.stringify(data, null, 2) + "\n")
    })
  }

  async touch(sessionId: string): Promise<void> {
    await this.#queue.run(async () => {
      await this.#ensureDir()
      const data = await this.read()
      const entry = data.sessions.find((s) => s.id === sessionId)
      if (entry) entry.lastActiveAt = new Date().toISOString()
      await atomicWrite(this.#indexPath, JSON.stringify(data, null, 2) + "\n")
    })
  }
}

export async function listSessions(dir: string): Promise<SessionEntry[]> {
  const text = await readSafe(path.join(dir, "sessions.json"))
  if (!text) return []
  try {
    return (JSON.parse(text) as SessionData).sessions ?? []
  } catch {
    return []
  }
}

export async function readSessionItems(
  dir: string,
  sessionId: string,
): Promise<AgentInputItem[]> {
  const fp = path.join(dir, `session-${sessionId}.jsonl`)
  return parseJsonl(await readSafe(fp)) as AgentInputItem[]
}

// ---------------------------------------------------------------------------
// JsonlSessionStore — reads/writes session-<id>.jsonl files
// ---------------------------------------------------------------------------

class JsonlSessionStore {
  #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  getFilePath(sessionId: string): string {
    return path.join(this.#dir, `session-${sessionId}.jsonl`)
  }

  async load(sessionId: string): Promise<PersistedItem[]> {
    await fs.promises.mkdir(this.#dir, { recursive: true })
    return parseJsonl(await readSafe(this.getFilePath(sessionId))) as PersistedItem[]
  }

  async append(sessionId: string, items: PersistedItem[]): Promise<void> {
    if (items.length === 0) return
    const jsonl = items.map((i) => JSON.stringify(i)).join("\n") + "\n"
    await atomicAppend(this.getFilePath(sessionId), jsonl)
  }

  async replace(sessionId: string, items: AgentInputItem[]): Promise<void> {
    const jsonl = items.length
      ? items.map((i) => JSON.stringify(i)).join("\n") + "\n"
      : ""
    await atomicWrite(this.getFilePath(sessionId), jsonl)
  }
}

// ---------------------------------------------------------------------------
// PersistentSession
// ---------------------------------------------------------------------------

export interface PersistentSessionOptions {
  sessionId?: string
  dir: string
  initialItems?: AgentInputItem[]
  logger?: unknown
  onCompact?: (text: string) => Promise<string | null | undefined>
  onCompactStart?: () => void
  onCompactEnd?: () => void
  compactionThreshold?: number
  retainItems?: number
}

export class PersistentSession {
  #inner: SDKMemorySession | null = null
  #sessionId!: string
  #store: JsonlSessionStore
  #index: SessionIndex
  #queue = new WriteQueue()
  #readyPromise: Promise<void>
  #onCompact?: (text: string) => Promise<string | null | undefined>
  #onCompactStart?: () => void
  #onCompactEnd?: () => void
  #compactionThreshold: number
  #retainItems: number
  #compacting = false

  constructor({
    sessionId,
    dir,
    initialItems = [],
    logger,
    onCompact,
    onCompactStart,
    onCompactEnd,
    compactionThreshold = 20,
    retainItems = 20,
  }: PersistentSessionOptions) {
    this.#store = new JsonlSessionStore(dir)
    this.#index = new SessionIndex(dir)
    this.#onCompact = onCompact
    this.#onCompactStart = onCompactStart
    this.#onCompactEnd = onCompactEnd
    this.#compactionThreshold = compactionThreshold
    this.#retainItems = retainItems
    this.#readyPromise = this.#init(sessionId, initialItems, logger)
  }

  async #init(
    sessionId: string | undefined,
    initialItems: AgentInputItem[],
    logger: unknown,
  ): Promise<void> {
    let resolvedId: string
    if (sessionId) {
      resolvedId = sessionId
      await this.#index.activate(resolvedId)
    } else {
      const current = await this.#index.currentSessionId()
      if (!current) {
        resolvedId = randomUUID()
        await this.#index.create(resolvedId)
      } else {
        resolvedId = current
        await this.#index.activate(resolvedId)
      }
    }

    type SDKOptions = NonNullable<ConstructorParameters<typeof SDKMemorySession>[0]>
    this.#inner = new SDKMemorySession({
      sessionId: resolvedId,
      logger: logger as SDKOptions["logger"],
    })
    this.#sessionId = resolvedId

    // Full JSONL is append-only and never modified. We filter in memory when building context.
    const rawPersistedItems = await this.#store.load(resolvedId)

    // Find the safe replay boundary: last completed assistant message or compaction marker.
    // Everything after it came from an interrupted turn (orphaned tool calls etc.) and is
    // excluded from the context window — but remains on disk for the full historical record.
    let safeEndIdx = -1
    for (let i = rawPersistedItems.length - 1; i >= 0; i--) {
      const item = rawPersistedItems[i]
      if (
        (item.type === "message" &&
          (item as { role?: string }).role === "assistant" &&
          (item as { status?: string }).status === "completed") ||
        item.type === "compaction_marker"
      ) {
        safeEndIdx = i
        break
      }
    }
    const allPersistedItems =
      safeEndIdx >= 0 ? rawPersistedItems.slice(0, safeEndIdx + 1) : []

    const CONTEXT_ITEMS = 100 // ~50 turns; older items remain on disk and in the semantic index

    const lastMarkerIdx = allPersistedItems.reduce(
      (last, item, i) => (item.type === "compaction_marker" ? i : last),
      -1,
    )

    let seedItems: AgentInputItem[]
    if (lastMarkerIdx >= 0) {
      const marker = allPersistedItems[lastMarkerIdx] as CompactionMarker
      const beforeMarker = allPersistedItems
        .slice(0, lastMarkerIdx)
        .filter(
          (item) =>
            item.type !== "reasoning" && item.type !== "compaction_marker",
        ) as (AgentInputItem & { _savedAt?: string })[]
      const afterMarker = allPersistedItems
        .slice(lastMarkerIdx + 1)
        .filter(
          (item) =>
            item.type !== "reasoning" && item.type !== "compaction_marker",
        ) as (AgentInputItem & { _savedAt?: string })[]

      // Recover toKeep items: items before the marker that were retained at compaction time
      const keptBefore = marker.keptSince
        ? beforeMarker.filter((i) => i._savedAt && i._savedAt >= marker.keptSince!)
        : beforeMarker.slice(-marker.retainCount)

      const summaryMsg: AgentInputItem = {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: `[Summary of earlier conversation]\n\n${marker.summary}`,
          },
        ],
      } as AgentInputItem

      const contextItems = [...keptBefore, ...afterMarker]
      seedItems = [summaryMsg, ...contextItems.slice(-CONTEXT_ITEMS)]
    } else {
      // No compaction yet — seed from persisted items or initialItems
      const persistedItems = allPersistedItems.filter(
        (item) =>
          item.type !== "reasoning" && item.type !== "compaction_marker",
      ) as AgentInputItem[]
      seedItems = (
        persistedItems.length > 0 ? persistedItems : initialItems
      ).slice(-CONTEXT_ITEMS)
      if (seedItems.length > 0 && persistedItems.length === 0) {
        // initialItems path: write to disk so they persist across restarts
        await this.#inner.addItems(seedItems)
        await this.#store.replace(resolvedId, await this.#inner.getItems())
        return
      }
    }

    if (seedItems.length > 0) {
      await this.#inner.addItems(seedItems)
    }
  }

  async getSessionId(): Promise<string> {
    await this.#readyPromise
    return this.#sessionId
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    await this.#readyPromise
    const items = await this.#inner!.getItems(limit)
    return items.filter((item) => item.type !== "reasoning")
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.#readyPromise
    await this.#queue.run(async () => {
      await this.#inner!.addItems(items)
      const ts = new Date().toISOString()
      await this.#store.append(
        this.#sessionId,
        items.map((i) => ({ ...i, _savedAt: ts })),
      )
      await this.#index.touch(this.#sessionId)
    })
    await this.#runCompaction()
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    await this.#readyPromise
    return this.#queue.run(async () => {
      const item = await this.#inner!.popItem()
      const items = await this.#inner!.getItems()
      await this.#store.replace(this.#sessionId, items)
      return item
    })
  }

  async clearSession(): Promise<void> {
    await this.#readyPromise
    return this.#queue.run(async () => {
      await this.#inner!.clearSession()
      await this.#store.replace(this.#sessionId, [])
      // sessions.json entry is preserved — session exists but is empty
    })
  }

  async #runCompaction({ force = false }: { force?: boolean } = {}): Promise<void> {
    if (!this.#onCompact || this.#compacting) return
    await this.#readyPromise
    const items = await this.#inner!.getItems()
    // Count completed assistant messages as turns — one per exchange, semantically meaningful.
    // Counting all non-user items (reasoning, function_calls, etc.) caused compaction to
    // re-trigger immediately after each compaction since retained items already hit the threshold.
    const turns = items.filter(
      (item) =>
        item.type === "message" &&
        (item as { role?: string }).role === "assistant" &&
        (item as { status?: string }).status === "completed",
    )
    if (!force && turns.length < this.#compactionThreshold) return

    this.#compacting = true
    this.#onCompactStart?.()
    try {
      const toCompact = items.slice(0, items.length - this.#retainItems)
      const toKeep = items.slice(items.length - this.#retainItems)

      const text = toCompact
        .filter((item) => item.type === "message")
        .map((item) => {
          const role = (item as { role?: string }).role === "user" ? "User" : "Assistant"
          const rawContent = (item as { content?: unknown }).content
          const content = Array.isArray(rawContent)
            ? (rawContent as ContentPart[])
                .filter(
                  (c) => c.type === "input_text" || c.type === "output_text",
                )
                .map((c) => c.text ?? "")
                .join(" ")
            : typeof rawContent === "string"
              ? rawContent
              : ""
          return content.trim() ? `${role}: ${content.trim()}` : null
        })
        .filter((line): line is string => line !== null)
        .join("\n")

      const summary = await this.#onCompact(text)
      if (!summary) return

      const summaryItem = {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: `[Summary of earlier conversation]\n\n${summary}`,
          },
        ],
      } as AgentInputItem

      const marker: CompactionMarker = {
        type: "compaction_marker",
        timestamp: new Date().toISOString(),
        summary,
        keptSince: (toKeep[0] as AgentInputItem & { _savedAt?: string })?._savedAt,
        retainCount: toKeep.length,
      }
      await this.#queue.run(async () => {
        await this.#store.append(this.#sessionId, [marker])
        await this.#inner!.clearSession()
        await this.#inner!.addItems([summaryItem, ...toKeep])
      })
    } finally {
      this.#compacting = false
      this.#onCompactEnd?.()
    }
  }
}
