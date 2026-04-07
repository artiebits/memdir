# memdir

Context and memory management for agents that learn over time.

## The problem

Sessions end. Memory clears. Without a way to carry the past experience forward, an agent is just a task-oriented tool. It never becomes something that feels like the same “person” from one conversation to the next.

The goal is not just remembering things, but building a persistent self that sees its past and future versions as one identity. This enables long-term learning and relationships.

A static SOUL.md injected into the system prompt gives you persistent identity too — the same text every run, even if you switch models.

But it stays the same over months and years.

This library attempts to give agents ability to build identity that persist and evolve across sessions, environments, and model swaps.

## Installation

```
npm i memdir
```

## Compatibility

It works with any LLM that supports tool calling — gpt-4o, Gemma, Qwen, DeepSeek, Kimi, Llama, and more. Tool calling is the mechanism by which the model can write, read and edit memory at the right moments. 

## Usage

```ts
import { PersistentSession, loadMemoryPrompt, getMemoryTools } from "memdir"

// `PersistentSession` manages the conversation history.
// Pass compactionClient and compactionModel to enable summarisation.
const session = new PersistentSession({
  compactionClient: client,
  compactionModel: "gemma4:e4b",
})

const buildSystemPrompt = async () => {
  const memoryPrompt = await loadMemoryPrompt()
  return `You are a helpful assistant.\n\n${memoryPrompt}`
}

const agent = new Agent({
  instructions: buildSystemPrompt,
  // getMemoryTools returns tools for your agent to manage memory.
  tools: [...yourTools, ...getMemoryTools()],
})

await run(agent, userInput, { session })
```

## API

* `new PersistentSession(options?)` — creates a disk-backed session that `run()` uses to persist and restore conversation history. Resumes the previous session automatically on restart. Pass `compactionClient` and `compactionModel` to enable automatic summarisation when the conversation grows long.
* `loadMemoryPrompt()` — returns the memory system prompt combined with the current contents of MEMORY.md. Add it to your agent's instructions so the model knows when and how to use the memory tools.
* `getMemoryTools()` — returns four memory tools: `memory_write`, `memory_search`, `memory_replace`, and `memory_delete`. Pass them to your agent's tool list.
* `session.clearSession()` — clears the session transcript and its semantic index entries. Execute it manually If you need to clear the current session and start fresh.

## How it works

memory is organised in four tiers, from most to least stable:

```
┌─────────────────────────────────────────────────────┐
│ SYSTEM PROMPT — always in context                   │
│   MEMORY.md: curated facts, rules, references       │
├─────────────────────────────────────────────────────┤
│ RECENT MESSAGES — last ~50 turns, verbatim          │
│   older turns summarised by compaction              │
├─────────────────────────────────────────────────────┤
│ SEMANTIC SEARCH — retrieved on demand               │
│   memory_search over full session history           │
├─────────────────────────────────────────────────────┤
│ FULL TRANSCRIPT — never deleted                     │
│   raw JSONL on disk, always queryable               │
└─────────────────────────────────────────────────────┘
```

* `MEMORY.md` holds curated long-term facts. The model writes to it via memory_write when something is worth keeping across sessions — user preferences, decisions, references. memdir injects the contents into the system prompt on every turn, so those facts stay present in context without requiring a search call.
* The semantic index covers the full session history. When the model needs context that has scrolled out of the conversation window, it calls `memory_search`, which embeds the query and finds the most relevant past exchanges by similarity. memdir runs indexing in the background every three turns so it never blocks a response.
* Compaction prevents the context window from filling up. When the number of assistant messages and tool calls in the window exceeds the configured threshold, memdir takes the oldest turns, sends them to the compaction model for summarisation, and replaces them with a single summary message. The raw transcript on disk stays untouched — compaction only affects what sits in the live context window.
* Session resumption happens automatically on restart. memdir reloads the last ~50 turns from disk into the context window, and the rest of the history stays available via semantic search.

## Upcoming Features

'Reflect' and 'Defragmentation' are upcoming features. Reflect allows the agent to review and refine its own internalized learnings, while Defragmentation optimizes context density by consolidating related memories.