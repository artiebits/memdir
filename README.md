# memdir

Memory manager for AI agents.

- No data leaves your machine
- Works with any LLM
- Stores memory in human-readable, editable files

**Who would use this?**

- Those who want fast setup without API keys or paid subscriptions
- Those who prioritize privacy and offline-first AI agents
- Those who want to open a .md file and see exactly what the agent "knows"

## Installation

```
npm i memdir
```

## Usage

Ollama example:

```ts
import { Memory } from "memdir"
import { Ollama } from "ollama"

const memory = new Memory()
const ollama = new Ollama()

async function embed(prompt) {
  const { embedding } = await ollama.embeddings({
    model: "nomic-embed-text",
    prompt,
  })
  return embedding
}

const { memoryPrompt, tools } = await memory.init(embed)

// Assemble the system prompt
const systemPrompt = `You are a helpful agent. ${memoryPrompt}`

let messages = [{ role: "system", content: systemPrompt }]
```

`init()` returns two things:

- `memoryPrompt` — memory instructions and stored facts. Append to your own system prompt.
- `tools` — `memory_write` and `memory_search` tools. Pass these to your model.

Then after each turn do:

```ts
messages = await memory.afterTurn(messages)
```

## API

### `new Memory({ dir? })`

Creates a new Memory instance. Accepts an optional `dir` option (default: `'./memory'`) telling where all files should be stored.

### `await memory.init(embedding)`

Initializes the memory manager and builds semantic index. Must be called once before anything else.

- `embedding` — `async (text) => number[]`

The embedding function must have this shape:

```ts
async function embed(text) {
  return [
    /* numbers */
  ]
}
```

Returns `{ memoryPrompt, tools }`.

### `await memory.afterTurn(messages)`

Call this after each completed turn. It appends the latest user/assistant pair to today's log, trims and refreshes the chat if it has grown past the character threshold, and returns the updated message array.

### `await memory.reindex()`

Rebuilds the in-memory index from `memory.md` and recent log files. Runs automatically on `init()`. Call it manually if you edit memory files outside the library.
