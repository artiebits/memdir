import { tool } from "@openai/agents"
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

function writeMemories(filePath: string, memories: string[]): void {
  const content =
    memories.map((m) => `- ${m}`).join("\n") + (memories.length ? "\n" : "")
  fs.writeFileSync(filePath, content, "utf8")
}

function writeMemory(filePath: string, content: string): string {
  const text = content.trim().replace(/^-\s*/, "")
  if (!text) return "Nothing to save."

  const memories = readMemories(filePath)
  if (memories.includes(text)) return "Memory already exists."

  memories.push(text)
  writeMemories(filePath, memories)
  return "Memory saved."
}

function deleteMemory(filePath: string, id: number): string {
  const memories = readMemories(filePath)
  if (id < 1 || id > memories.length) return `No memory with id ${id}.`

  const [removed] = memories.splice(id - 1, 1)
  writeMemories(filePath, memories)
  return `Deleted memory #${id}: ${removed}`
}

export function createMemoryTools(memoryFilePath: string) {
  return [
    tool({
      name: "memory_write",
      description:
        "Save a fact worth remembering across sessions. Use proactively when you learn something important about the user, their preferences, feedback, or project context.",
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
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const { content } = input as { content: string }
        return writeMemory(memoryFilePath, content)
      },
    }),

    tool({
      name: "memory_delete",
      description:
        "Delete a saved memory by its ID number. The ID is the number shown before the memory in the Memory section (e.g. 1 for [1]).",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description:
              "The number shown before the memory in the Memory section.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const { id } = input as { id: number }
        return deleteMemory(memoryFilePath, id)
      },
    }),
  ]
}
