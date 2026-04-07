import Database from "better-sqlite3"
import path from "node:path"
import fs from "node:fs"

export function openDb(dir: string): Database.Database {
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, "memory.db")

  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      is_current INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      item TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_items_session_id ON session_items(session_id, id);
  `)

  return db
}
