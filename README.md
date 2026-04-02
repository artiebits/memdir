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

```ts
import { Memory } from "memdir"

const memory = new Memory()
const { memoryPrompt, tools: memoryTools } = await memory.init()

const agent = new Agent({
  instructions: `You are a helpful assistant.\n\n${memoryPrompt}`,
  tools: [...yourTools, ...memoryTools],
})
```

After each turn:

```ts
messages = await memory.afterTurn(messages)
```

## API

### `new Memory({ dir? })`

Creates a new Memory instance. Accepts an optional `dir` option (default: `'./memory'`) telling where all files should be stored.

### `await memory.init()`

Initializes the memory manager and builds the semantic index. Must be called once before anything else. Returns `{ memoryPrompt, tools }`.

### `await memory.afterTurn(messages)`

Call this after each completed turn. It appends the latest user/assistant pair to today's log, trims and refreshes the chat if it has grown past the character threshold, and returns the updated message array.

### `await memory.reindex()`

Rebuilds the in-memory index from `memory.md` and recent log files. Runs automatically on `init()`. Call it manually if you edit memory files outside the library.

## Tools

Three tools are returned by `init()` and passed to your model:

- `memory_write` — saves a fact to `memory.md`. The model calls this when it learns something worth remembering.
- `memory_search` — searches past conversations and saved facts by semantic similarity.
- `memory_delete` — deletes a saved fact from `memory.md`.
