import Database from "better-sqlite3"
import path from "node:path"
import { openDb } from "./db.js"
import { ContextManager } from "./ContextManager.js"
import { loadMemoryPrompt } from "./loadMemoryPrompt.js"
import { createMemoryTools } from "./memoryTools.js"

export class MemoryManager {
  private database: Database.Database
  private memoryFilePath: string
  public contextManager: ContextManager

  constructor(dir: string, initialSessionId?: string) {
    this.database = openDb(dir)
    this.memoryFilePath = path.join(dir, "memories.md")
    this.contextManager = new ContextManager(this.database, initialSessionId)
  }

  async getMemoryPrompt(envContext?: string): Promise<string> {
    return loadMemoryPrompt(
      this.memoryFilePath,
      envContext,
      this.contextManager.getLastActiveAt(),
    )
  }

  getMemoryTools() {
    return createMemoryTools(this.memoryFilePath)
  }

  async loadSession(sessionId: string): Promise<void> {
    this.contextManager = new ContextManager(this.database, sessionId)
  }

  createNewSession(): void {
    this.contextManager = new ContextManager(this.database)
  }

  async clearCurrentSession() {
    await this.contextManager.clearSession()
  }

  async getCurrentSessionId() {
    return this.contextManager.getSessionId()
  }
}
