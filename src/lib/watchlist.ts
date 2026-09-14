import { useStore, type Range } from '../store'
import { BRIDGE_HTTP_URL } from '../config'

type Patch = Partial<{ symbols: string[]; range: Range; compare: string[] }>

/**
 * An edit to the saved watchlist from the page: shown at once, then saved on
 * the bridge. The bridge's answer — the list as it actually saved it, cleaned
 * and capped — settles the page, and reaches every other face over the socket.
 * A failed save is left to the next push from the bridge to correct.
 */
export function saveWatchlist(patch: Patch): Promise<void> {
  const s = useStore.getState()
  s.setWatchlist({ ...s.watchlist, ...patch })
  return fetch(`${BRIDGE_HTTP_URL}/dash/watchlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((saved) => useStore.getState().setWatchlist(saved))
    .catch(() => {})
}
