import { useEffect, useRef, useState } from 'react'
import { useStore, type NowPlaying } from '../store'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The dash's Now playing tile: the Spotify app on this Mac, live, with its
 * transport and volume (bridge/music.mjs). The bridge follows the app every
 * couple of seconds while this page is open and only speaks up when something
 * changes; in between, the position is carried forward on the page's own
 * clock, so the bar moves smoothly.
 */

/** Remote pictures come through the bridge, as the media hub's do. */
const viaBridge = (url: string) => `${BRIDGE_HTTP_URL}/img?url=${encodeURIComponent(url)}`
const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`

/** Drawn rather than emoji, which a Mac paints in colour. */
const ICONS = {
  previous: 'M3 3h2v10H3zM13 3v10L6 8z',
  next: 'M11 3h2v10h-2zM3 3v10l7-5z',
  play: 'M4.5 2.5v11L13 8z',
  pause: 'M4 3h3v10H4zM9 3h3v10H9z',
}
const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden>
    <path d={d} />
  </svg>
)

/** A control for the app, through the bridge. The new state comes back in the
 *  reply, and on the socket to any other window. */
function send(body: { action?: 'toggle' | 'next' | 'previous'; volume?: number }) {
  return fetch(`${BRIDGE_HTTP_URL}/dash/spotify/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (r) => {
      const p = (await r.json().catch(() => ({}))) as { data?: NowPlaying; error?: string }
      if (!r.ok) throw new Error(p.error ?? 'Spotify did not respond.')
      if (p.data) useStore.getState().setNowPlaying(p.data)
    })
    .catch((err: Error) =>
      useStore.getState().setError(err instanceof TypeError ? 'Spotify controls need the bridge running.' : err.message),
    )
}

export function NowPlayingReadout({ np }: { np: NowPlaying | null }) {
  const [now, setNow] = useState(() => Date.now())
  const live = Boolean(np?.playing && np.durationMs && np.progressMs != null)
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [live])

  // The slider follows the hand at once; the app hears it a moment after the
  // hand stops, not on every step of the drag.
  const [volume, setVolume] = useState<number | null>(null)
  const volumeTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(volumeTimer.current), [])
  const onVolume = (v: number) => {
    setVolume(v)
    window.clearTimeout(volumeTimer.current)
    volumeTimer.current = window.setTimeout(() => void send({ volume: v }).finally(() => setVolume(null)), 250)
  }

  if (!np) return <p className="dash-empty">Looking for Spotify…</p>
  if (np.error) return <p className="dash-empty">{np.error}</p>
  if (np.app === 'closed') return <p className="dash-empty">Spotify isn't open on this Mac.</p>
  if (!np.title) return <p className="dash-empty">Nothing playing.</p>

  // Never backwards: the clock only ticks while a song plays, so a fresh read
  // can land before the next tick and briefly look older than `now`.
  const since = live ? Math.max(0, now - np.at) : 0
  const elapsed = np.progressMs != null ? np.progressMs + since : null
  const shown = elapsed != null && np.durationMs ? Math.min(elapsed, np.durationMs) : elapsed
  const level = volume ?? np.volume
  return (
    <>
      <div className="dash-np" title={`${np.title} — ${np.artist}${np.album ? ` · ${np.album}` : ''}`}>
        {np.art ? <img className="dash-np-art" src={viaBridge(np.art)} alt="" /> : <span className="dash-np-art" aria-hidden />}
        <span className="dash-np-text">
          {np.url ? (
            <a href={np.url} target="_blank" rel="noreferrer">
              {np.title}
            </a>
          ) : (
            <b>{np.title}</b>
          )}
          <small>
            {np.artist}
            {!np.playing
              ? ' · paused'
              : shown != null && np.durationMs
                ? ` · ${mmss(shown)} / ${mmss(np.durationMs)}`
                : ''}
          </small>
        </span>
        <span className="dash-np-controls">
          <button type="button" className="dash-np-btn" aria-label="Previous track" title="Previous" onClick={() => void send({ action: 'previous' })}>
            <Icon d={ICONS.previous} />
          </button>
          <button
            type="button"
            className="dash-np-btn is-main"
            aria-label={np.playing ? 'Pause' : 'Play'}
            title={np.playing ? 'Pause' : 'Play'}
            onClick={() => void send({ action: 'toggle' })}
          >
            <Icon d={np.playing ? ICONS.pause : ICONS.play} />
          </button>
          <button type="button" className="dash-np-btn" aria-label="Next track" title="Next" onClick={() => void send({ action: 'next' })}>
            <Icon d={ICONS.next} />
          </button>
        </span>
      </div>
      <div className="dash-np-foot">
        <span className="dash-np-bar" aria-hidden>
          {np.durationMs && shown != null ? <i style={{ transform: `scaleX(${Math.min(1, shown / np.durationMs)})` }} /> : null}
        </span>
        {level != null && (
          <input
            type="range"
            className="dash-np-volume"
            min={0}
            max={100}
            step={1}
            value={level}
            aria-label="Spotify volume"
            title={`Volume ${level}`}
            onChange={(e) => onVolume(Number(e.currentTarget.value))}
          />
        )}
      </div>
    </>
  )
}
