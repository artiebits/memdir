import { type AgentInputItem } from "@openai/agents"
import { PersistentSession as _PersistentSession, type PersistentSessionOptions } from "./src/session.js"
import { indexTurn, clearSessionIndex } from "./src/memory.js"

function isCompletedAssistantMessage(item: AgentInputItem): boolean {
  if (item.type !== "message" || item.role !== "assistant") return false
  return (item as { status?: string }).status === "completed"
}

const COMPACTION_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Your response must contain an <analysis> block followed by a <summary> block.

Your task is to summarise the conversation so far. This summary will replace the conversation history — it must contain everything needed to continue naturally.

Before writing the summary, wrap your thinking in <analysis> tags. Then write the summary inside <summary> tags.

Your summary must include:

1. User — preferences, habits, constraints, and facts learned about the user
2. Decisions — key decisions made and why
3. User messages — ALL user messages verbatim (not paraphrased)
4. Current context — what was being discussed or worked on at the end
5. Open threads — any unresolved requests or pending topics

REMINDER: plain text only. No tool calls.`

// Strip the <analysis> scratchpad — it improves summary quality but has no value once written.
// Extract the <summary> block if present; otherwise return the raw text trimmed.
function formatCompactionSummary(raw: string): string {
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/, "")
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) text = match[1]
  return text.trim()
}

interface CompactionClient {
  chat: {
    completions: {
      create(options: {
        model: string
        messages: { role: string; content: string }[]
      }): Promise<{ choices: [{ message: { content: string } }] }>
    }
  }
}

export interface PersistentSessionWithCompactionOptions
  extends PersistentSessionOptions {
  compactionClient?: CompactionClient
  compactionModel?: string
}

// PersistentSession with automatic turn indexing, index cleanup, and built-in compaction.
// Pass compactionClient + compactionModel to enable automatic context window management.
export class PersistentSession extends _PersistentSession {
  constructor({
    compactionClient,
    compactionModel,
    ...rest
  }: PersistentSessionWithCompactionOptions) {
    let onCompact: PersistentSessionOptions["onCompact"]
    if (compactionClient && compactionModel) {
      onCompact = async (text: string) => {
        const res = await compactionClient.chat.completions.create({
          model: compactionModel,
          messages: [
            { role: "system", content: COMPACTION_PROMPT },
            { role: "user", content: text },
          ],
        })
        return formatCompactionSummary(res.choices[0].message.content)
      }
    }
    super({ ...rest, onCompact })
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await super.addItems(items)
    if (items.some(isCompletedAssistantMessage)) {
      const [allItems, sessionId] = await Promise.all([
        this.getItems(),
        this.getSessionId(),
      ])
      indexTurn(allItems, sessionId)
    }
  }

  async clearSession(): Promise<void> {
    const sessionId = await this.getSessionId()
    await super.clearSession()
    await clearSessionIndex(sessionId)
  }
}

export { loadMemoryPrompt, getMemoryTools } from "./src/memory.js"
