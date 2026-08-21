/**
 * Storage boundaries.
 *
 * Only interfaces and in-memory implementations live here so that `core`
 * stays free of platform APIs. Node and React Native adapters are provided
 * by the host application.
 */

/**
 * Append-only sink. Implementations must never expose truncation or
 * rewriting: the audit trail depends on it.
 */
export interface AppendOnlyStore {
  /** Append one record. Implementations add the line separator. */
  append(line: string): Promise<void>
}

/** Simple keyed document storage for session state and policy overrides. */
export interface DocumentStore {
  read(key: string): Promise<string | undefined>
  write(key: string, value: string): Promise<void>
}

/** In-memory {@link AppendOnlyStore} for tests. */
export class MemoryAppendOnlyStore implements AppendOnlyStore {
  readonly lines: string[] = []

  append(line: string): Promise<void> {
    this.lines.push(line)
    return Promise.resolve()
  }
}

/** In-memory {@link DocumentStore} for tests. */
export class MemoryDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, string>()

  read(key: string): Promise<string | undefined> {
    return Promise.resolve(this.documents.get(key))
  }

  write(key: string, value: string): Promise<void> {
    this.documents.set(key, value)
    return Promise.resolve()
  }
}
