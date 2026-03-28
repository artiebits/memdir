# memdir

File-based memory for AI agents.

Markdown is the source of truth. Embeddings are just a cache for semantic search.

Fully local - no data leaves your machine, no dependencies, no API keys or subscriptions.

## How it works

`memdir` keeps two local sources of truth: facts worth remembering in `memory.md`, and chat history in daily logs. On startup, it rebuilds an in-memory semantic index from those files using the embedding model.

Two storage files:

- `memory.md` long-term memory
- `YYYY-MM-DD.jsonl` past conversation logs

On startup, it rebuilds an in-memory semantic index from `memory.md` and recent log files.

## Usage

```js
import { Memory } from "memdir"
import { Ollama } from "ollama"
import { SOUL, AGENT } from "./systemPrompts.js"

const memory = new Memory()
const ollama = new Ollama()

const { memoryPrompt, tools } = await memory.init(async (text) => {
  const result = await ollama.embeddings({ model: "nomic-embed-text", prompt: text })
  return result.embedding
})

const systemPrompt = `
${SOUL}

${AGENT}

${memoryPrompt}
`.trim()

let messages = [{ role: "system", content: systemPrompt }]
```

`init()` returns two things to wire into your agent:

- **`memoryPrompt`** — memory instructions and stored facts. Append to your own system prompt.
- **`tools`** — `memory_write` and `memory_search` tools. Pass these to your model.

Then after each turn:

```js
messages = await memory.afterTurn(messages)
```

## API

### `new Memory({ dir? })`

| Option | Default      | Description                          |
| ------ | ------------ | ------------------------------------ |
| `dir`  | `'./memory'` | Directory where all files are stored |

### `await memory.init(embedding)`

Initialises the manager. Must be called once before anything else.

- **`embedding`** — `async (text) => number[]`

The embedding function must have this shape:

```js
async function embed(text) {
  return [
    /* numbers */
  ]
}
```

Returns `{ memoryPrompt, tools }`.

### `await memory.afterTurn(messages)`

Convenience helper for completed turns. It finds the latest user/assistant pair
already present in `messages`, appends it to today's log, then runs `maybeFlush()`
and returns the updated message array.

The latest completed user and assistant messages must already be in `messages`.

### `await memory.reindex()`

Rebuilds the in-memory index from `memory.md` and recent log files. Runs automatically on `init()`. Call it manually if you edit memory files outside the library.

## Tools

The agent gets two tools automatically:

**`memory_write`** — saves a fact to `memory.md` that should persist across future conversations.

**`memory_search`** — searches past conversations and stored facts by semantic similarity. Use when the current message likely depends on prior context.

Your app should assemble the final system prompt itself. A good pattern is:

```js
import { SOUL, AGENT } from "./systemPrompts.js"

const systemPrompt = `
${SOUL}

${AGENT}

${memoryPrompt}
`.trim()
```

## Embeddings

The library does not create embeddings for you. You should pass a function that
turns a single string into an embedding vector.

Ollama example:

```js
import { Ollama } from "ollama"
import { Memory } from "memdir"
import agentPrompt from "./agentPrompt.js"

const memory = new Memory()
const ollama = new Ollama()

async function embed(text) {
  const { embedding } = await ollama.embeddings({
    model: "nomic-embed-text",
    prompt: text,
  })
  return embedding
}

const { systemContent, tools } = await memory.init(agentPrompt, embed)
```

node-llama-cpp example:

```js
import { getLlama } from "node-llama-cpp"
import { Memory } from "memdir"
import agentPrompt from "./agentPrompt.js"

const memory = new Memory()

const llama = await getLlama()
const model = await llama.loadModel({ modelPath: "./models/bge-small-en-v1.5-q8_0.gguf" })
const context = await model.createEmbeddingContext()

async function embed(text) {
  const embedding = await context.getEmbeddingFor(text)
  return embedding.vector
}

const { systemContent, tools } = await memory.init(agentPrompt, embed)
```
