# memdir

Context and memory management for agents that learn over time.

## The problem

Sessions end. Memory clears. Without a way to carry the past experience forward, an agent is just a task-oriented tool. It never becomes something that feels like the same person from one conversation to the next.

The goal is not just remembering things, but building a persistent self that sees its past and future versions as one identity. This enables long-term learning and relationships.

A static SOUL.md injected into the system prompt gives you persistent identity too — the same text every run, even if you switch models.

But it stays the same over months and years.

This library attempts to give agents ability to build identity that persists and evolves across sessions, environments, and model swaps.

## Installation

```
npm i memdir
```

## Compatibility

It works with any LLM that supports tool calling — gpt-4o, Gemma, Qwen, DeepSeek, Kimi, Llama, and more. Tool calling is the mechanism by which the model can write and delete memories at the right moments.

## Usage

```ts
import { MemoryManager } from "memdir"

const memory = new MemoryManager()

const agent = new Agent({
  instructions: memory.getMemoryPrompt(),
  tools: [...yourTools, ...memory.getMemoryTools()],
})

const session = memory.contextManager

await run(agent, userInput, { session })
```

## API

- `new MemoryManager(dir, sessionId?)` — creates a manager backed by a SQLite database in `dir`. Resumes the most recent session automatically on restart. Pass a `sessionId` to target a specific session.
- `memory.contextManager` — the `ContextManager` instance. Pass it as `session` to `run()` so the SDK uses it for conversation history.
- `memory.getMemoryPrompt(envContext?)` — returns the memory system prompt combined with the current contents of `memories.md`. Add it to your agent's instructions so the model knows when and how to use the memory tools.
- `memory.getMemoryTools()` — returns two memory tools: `memory_write` and `memory_delete`. Pass them to your agent's tool list.
- `memory.loadSession(sessionId)` — switch the manager to an existing session.
- `memory.createNewSession()` — start a fresh session.
- `memory.clearCurrentSession()` — clear the current session's conversation history.

## How it works

Memory is organised in three tiers, from most to least stable:

```
┌─────────────────────────────────────────────────────┐
│ SYSTEM PROMPT — always in context                   │
│   memories.md: curated facts, rules, references     │
├─────────────────────────────────────────────────────┤
│ RECENT MESSAGES — sliding window, last N turns      │
│   stored in SQLite, replayed verbatim on restart    │
├─────────────────────────────────────────────────────┤
│ FULL HISTORY — always on disk                       │
│   all turns in SQLite, never deleted                │
└─────────────────────────────────────────────────────┘
```

- `memories.md` holds curated long-term facts. The model writes to it via `memory_write` when something is worth keeping across sessions — user preferences, decisions, references. memdir injects the contents into the system prompt on every turn so those facts stay present without requiring a search call. Each memory is numbered so the model can delete by ID via `memory_delete`.
- The context window uses a sliding window. `ContextManager.getItems(maxItems)` returns the last N turns from SQLite. When the window is full, the oldest turns fall out of context but remain in the database — the full history is never deleted.
- Session resumption happens automatically on restart. The most recent session is loaded and its last N turns are replayed into the context window.
- Storage is a single SQLite file (`memory.db`) in the directory you provide. All sessions and their items live there.

## Upcoming Features

'Reflect' and 'Defragmentation' are upcoming features. Reflect allows the agent to review and refine its own internalized learnings, while Defragmentation optimizes context density by consolidating related memories.
