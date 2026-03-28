export type EmbedFn = (text: string) => Promise<number[]>

export type Message = {
  role: string
  content: string
}

export type InitResult = {
  memoryPrompt: string
  tools: object[]
}

export type FlushOptions = {
  charThreshold?: number
  maxHistory?: number
  basePrompt?: string
}

export type MemoryOptions = {
  dir?: string
}

export class Memory {
  constructor(opts?: MemoryOptions)
  init(embedFn: EmbedFn): Promise<InitResult>
  appendLog(userContent: string, assistantContent: string): Promise<void>
  afterTurn(messages: Message[]): Promise<Message[]>
  reindex(): Promise<void>
  maybeFlush(messages: Message[], opts?: FlushOptions): Promise<Message[] | null>
}
