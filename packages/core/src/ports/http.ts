/**
 * Minimal HTTP boundary.
 *
 * A structural subset of the global `fetch`, narrow enough that a test can
 * satisfy it with a few lines and wide enough for the one thing backends need:
 * a GET with request headers and a JSON body. The global `fetch` is assignable
 * to it, so production code passes `globalThis.fetch` unchanged.
 */

export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export interface HttpRequestInit {
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>

/** Build a {@link FetchLike} that answers from a fixed table, for tests. */
export function stubFetch(
  handler: (url: string, init?: HttpRequestInit) => { status?: number; body: unknown } | Error,
): FetchLike {
  return (url, init) => {
    const result = handler(url, init)
    if (result instanceof Error) return Promise.reject(result)
    const status = result.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(result.body),
    })
  }
}
