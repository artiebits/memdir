import fs from "node:fs"

export class WriteQueue {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.#tail.then(fn)
    this.#tail = op.catch((err: unknown) => console.error("[WriteQueue]", err))
    return op
  }
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.promises.writeFile(tmp, content, "utf8")
  try {
    await fs.promises.rename(tmp, filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
      await fs.promises.unlink(tmp).catch(() => {})
      throw err
    }
    await fs.promises.writeFile(filePath, content, "utf8")
    await fs.promises.unlink(tmp).catch(() => {})
  }
}

export async function atomicAppend(filePath: string, content: string): Promise<void> {
  const existing = await readSafe(filePath)
  await atomicWrite(filePath, `${existing}${content}`)
}

export async function readSafe(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw err
  }
}

export function parseJsonl(text: string): unknown[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}
