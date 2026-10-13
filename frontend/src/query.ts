import { QueryClient } from '@tanstack/react-query'

// The effects this replaced never retried and never refetched on focus.
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

/** A debounce inside a queryFn: a key that changes before `ms` is up leaves its query
 *  unwatched, which aborts the signal, so only the last pause in typing asks the tower. */
export const pause = (ms: number, signal: AbortSignal) =>
  new Promise(done => setTimeout(done, ms)).then(() => signal.throwIfAborted())
