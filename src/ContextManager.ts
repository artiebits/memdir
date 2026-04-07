import Database from "better-sqlite3"
import type {
  AgentInputItem,
  UserMessageItem,
  AssistantMessageItem,
  FunctionCallResultItem,
} from "@openai/agents"
import { Session } from "@openai/agents"
import { randomUUID } from "node:crypto"

type BuildContextOptions = {
  sessionId?: string
  maxRecentItems?: number
}

export class ContextManager implements Session {
  private database: Database.Database
  private sessionId: string
  private previousLastActiveAt?: string

  constructor(database: Database.Database, initialSessionId?: string) {
    this.database = database

    if (initialSessionId) {
      this.sessionId = initialSessionId
      this.ensureSessionExists()
    } else {
      // Load most recent "current" session or create new one
      const row = this.database
        .prepare(
          "SELECT id FROM sessions WHERE is_current = 1 ORDER BY last_active_at DESC LIMIT 1",
        )
        .get() as { id: string } | undefined

      this.sessionId = row?.id ?? randomUUID()
      this.ensureSessionExists()
    }

    // Capture last_active_at before overwriting it so we can compute the time gap
    const prev = this.database
      .prepare("SELECT last_active_at FROM sessions WHERE id = ?")
      .get(this.sessionId) as { last_active_at: string } | undefined
    this.previousLastActiveAt = prev?.last_active_at

    // Mark this session as current
    this.markSessionAsCurrent()
  }

  getLastActiveAt(): string | undefined {
    return this.previousLastActiveAt
  }

  private ensureSessionExists(): void {
    const exists = this.database
      .prepare("SELECT 1 FROM sessions WHERE id = ?")
      .get(this.sessionId)

    if (!exists) {
      this.database
        .prepare(
          `INSERT INTO sessions (id, created_at, last_active_at, is_current)
           VALUES (?, ?, ?, 1)`,
        )
        .run(this.sessionId, new Date().toISOString(), new Date().toISOString())
    }
  }

  private markSessionAsCurrent(): void {
    this.database.prepare("UPDATE sessions SET is_current = 0").run()

    this.database
      .prepare(
        "UPDATE sessions SET is_current = 1, last_active_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), this.sessionId)
  }

  async getSessionId(): Promise<string> {
    return this.sessionId
  }

  async getItems(maxItems: number = 100): Promise<AgentInputItem[]> {
    const rows = this.database
      .prepare(
        `
        SELECT item
        FROM session_items
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      `,
      )
      .all(this.sessionId, maxItems)

    return rows
      .reverse()
      .map((row: any) => JSON.parse(row.item))
      .filter((item): item is AgentInputItem => this.shouldInclude(item))
      .map((item) => this.trimToolResult(item))
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const timestamp = new Date().toISOString()
    const insert = this.database.prepare(`
      INSERT INTO session_items (session_id, item, saved_at)
      VALUES (?, ?, ?)
    `)

    const tx = this.database.transaction(() => {
      for (const item of items) {
        insert.run(
          this.sessionId,
          JSON.stringify(this.trimToolResult(item)),
          timestamp,
        )
      }
    })

    tx()
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const row = this.database
      .prepare(
        `
        SELECT id, item
        FROM session_items
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT 1
        `,
      )
      .get(this.sessionId) as { id: number; item: string } | undefined

    if (!row) return undefined

    this.database.prepare("DELETE FROM session_items WHERE id = ?").run(row.id)

    return JSON.parse(row.item)
  }

  async clearSession(): Promise<void> {
    this.database
      .prepare("DELETE FROM session_items WHERE session_id = ?")
      .run(this.sessionId)
  }

  // Optional: buildContext can be extended later with summarization etc.
  async buildContext(options?: BuildContextOptions): Promise<AgentInputItem[]> {
    const maxRecent = options?.maxRecentItems ?? 100
    return this.getItems(maxRecent)
  }

  // ============================
  // Filtering & trimming
  // ============================
  private isMessageItem(item: AgentInputItem): item is UserMessageItem | AssistantMessageItem {
    return "role" in item && (item.role === "user" || item.role === "assistant")
  }

  private isFunctionCallResult(item: AgentInputItem): item is FunctionCallResultItem {
    return (item as { type?: string }).type === "function_call_result"
  }

  shouldStore(item: AgentInputItem): boolean {
    if (!this.isMessageItem(item)) return false

    const text = this.extractText(item.content)
    if (!text || text.length < 40) return false

    return true
  }

  private shouldInclude(item: AgentInputItem): boolean {
    return this.isMessageItem(item) || this.isFunctionCallResult(item)
  }

  private extractText(content: any): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part: any) => ((part?.text ?? part?.image_url) ? "[image]" : ""))
        .join(" ")
    }
    return ""
  }

  private trimToolResult(item: AgentInputItem): AgentInputItem {
    if (!this.isFunctionCallResult(item)) return item

    const text = typeof item.output === "string" ? item.output : ""
    if (text.length < 600) return item

    return {
      ...item,
      output: `[tool_result summary]\n${text.slice(0, 500)}...`,
    }
  }
}
