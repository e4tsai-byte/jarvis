import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The media hub: live news, markets and headlines, bottom-right of the
 * dashboard. Every request goes to the bridge, which does the fetching; JARVIS
 * switches tabs, channels and symbols by voice through the same store the tabs
 * write to.
 */

type Channel = { id: string; name: string; short: string }
type Quote = {
  symbol: string
  name: string
  price: number
  change: number | null
  changePct: number | null
  currency: string
  points: [number, number][]
  source: string
}
type Headline = { title: string; link: string; source: string; short: string; time: number | null }

const WATCHLIST = ['NVDA', 'AAPL', 'SPY', 'BTC-USD']
const YT = 'https://www.youtube-nocookie.com'
const TABS = [
  ['live', 'Live'],
  ['markets', 'Markets'],
  ['headlines', 'Headlines'],
] as const

const api = <T,>(path: string): Promise<T> =>
  fetch(`${BRIDGE_HTTP_URL}${path}`, { signal: AbortSignal.timeout(12_000) }).then((r) =>
    r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status))),
  )

export function MediaHub() {
  const tab = useStore((s) => s.media.tab)
  return (
    <section className="dash-slot dash-media" data-slot="media">
      <nav className="media-tabs" role="tablist" aria-label="Media">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => useStore.getState().setMedia({ tab: id })}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="media-body">
        {tab === 'live' && <LiveTab />}
        {tab === 'markets' && <MarketsTab />}
        {tab === 'headlines' && <HeadlinesTab />}
      </div>
    </section>
  )
}

// --------------------------------------------------------------------- live

function LiveTab() {
  const channel = useStore((s) => s.media.channel)
  const sound = useStore((s) => s.media.sound)
  const phase = useStore((s) => s.phase)
  const [channels, setChannels] = useState<Channel[]>([])
  const [video, setVideo] = useState<{ name: string; videoId: string | null } | null>(null)
  const [error, setError] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    api<Channel[]>('/dash/channels').then(setChannels).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    setVideo(null)
    setError('')
    api<{ name: string; videoId: string | null }>(`/dash/live?channel=${encodeURIComponent(channel)}`)
      .then((v) => alive && setVideo(v))
      .catch(() => alive && setError('That channel could not be reached.'))
    return () => {
      alive = false
    }
  }, [channel])

  // The anchor never talks over either of them: muted while the user holds
  // Space, and while JARVIS speaks. Otherwise it follows the sound switch.
  const quiet = !sound || phase === 'listening' || phase === 'speaking'

  useEffect(() => {
    const send = () =>
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func: quiet ? 'mute' : 'unMute', args: [] }),
        YT,
      )
    // The player only listens once it has finished loading, and says nothing
    // when it does — so the command is repeated over its first few seconds.
    send()
    const timers = [400, 1500, 3500].map((ms) => window.setTimeout(send, ms))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [quiet, video?.videoId])

  const src = video?.videoId
    ? `${YT}/embed/${video.videoId}?autoplay=1&mute=1&enablejsapi=1&playsinline=1&rel=0&origin=${encodeURIComponent(window.location.origin)}`
    : null

  return (
    <div className="media-live">
      <div className="media-screen">
        {src ? (
          <iframe
            ref={frame}
            src={src}
            title={`${video?.name ?? 'News'} live`}
            allow="autoplay; encrypted-media; picture-in-picture"
          />
        ) : (
          <p className="media-note">
            {error || (video ? `${video.name} is not live right now.` : 'Tuning in…')}
          </p>
        )}
      </div>
      <div className="media-row">
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            title={c.name}
            className={c.id === channel ? 'on' : ''}
            onClick={() => useStore.getState().setMedia({ tab: 'live', channel: c.id })}
          >
            {c.short}
          </button>
        ))}
        <button
          type="button"
          className={`media-sound${sound ? ' on' : ''}`}
          aria-pressed={sound}
          onClick={() => useStore.getState().setMedia({ sound: !sound })}
        >
          {sound ? 'Sound on' : 'Muted'}
        </button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ markets

const fmtPrice = (v: number) =>
  v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2)
const fmtPct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`)

function MarketsTab() {
  const symbol = useStore((s) => s.media.symbol)
  const [quotes, setQuotes] = useState<Record<string, Quote | 'error'>>({})
  // A symbol JARVIS was asked about joins the front of the list for now.
  const list = useMemo(
    () => (symbol && !WATCHLIST.includes(symbol) ? [symbol, ...WATCHLIST].slice(0, 6) : WATCHLIST),
    [symbol],
  )
  const active = symbol || WATCHLIST[0]

  useEffect(() => {
    let alive = true
    const load = () =>
      list.forEach((s) =>
        api<Quote>(`/dash/market?symbol=${encodeURIComponent(s)}`)
          .then((q) => alive && setQuotes((p) => ({ ...p, [s]: q })))
          .catch(() => alive && setQuotes((p) => ({ ...p, [s]: 'error' }))),
      )
    load()
    const id = window.setInterval(load, 60_000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [list])

  const q = quotes[active]
  return (
    <div className="media-markets">
      <div className="media-chart">
        {q && q !== 'error' ? (
          <PriceChart quote={q} />
        ) : (
          <p className="media-note">{q === 'error' ? `No data for ${active} right now.` : 'Loading…'}</p>
        )}
      </div>
      <ul className="media-watch">
        {list.map((s) => {
          const w = quotes[s]
          const pct = w && w !== 'error' ? w.changePct : null
          return (
            <li key={s}>
              <button
                type="button"
                className={s === active ? 'on' : ''}
                onClick={() => useStore.getState().setMedia({ tab: 'markets', symbol: s })}
              >
                <span>{s.replace('-USD', '')}</span>
                <span>
                  {pct === null ? '—' : <i className={pct >= 0 ? 'up' : 'down'}>{pct >= 0 ? '▲' : '▼'}</i>}{' '}
                  {fmtPct(pct)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * One symbol's day, as a line. A single series, so no legend — the header
 * names it. The dashed line is the previous close, which is what the day's
 * change is measured against. Hovering shows the price at that moment.
 */
function PriceChart({ quote }: { quote: Quote }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 320, h: 150 })
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: Math.max(160, e.contentRect.width), h: Math.max(90, e.contentRect.height) }),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pts = quote.points
  const prev = quote.change === null ? null : quote.price - quote.change
  const pad = { l: 6, r: 52, t: 30, b: 18 }
  const w = size.w
  const h = size.h
  const values = pts.map((p) => p[1]).concat(prev === null ? [] : [prev])
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const t0 = pts[0]?.[0] ?? 0
  const t1 = pts.at(-1)?.[0] ?? 1
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b)

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('')
  const area = pts.length ? `${line}L${x(t1).toFixed(1)},${h - pad.b}L${x(t0).toFixed(1)},${h - pad.b}Z` : ''
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pts.length) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = t0 + ((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (t1 - t0)
    let best = 0
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - t) < Math.abs(pts[best][0] - t)) best = i
    setHover(best)
  }
  const hp = hover === null ? null : pts[hover]
  const up = (quote.change ?? 0) >= 0

  return (
    <div className="price-chart" ref={box}>
      <div className="price-head">
        <b>{quote.symbol.replace('-USD', '')}</b>
        <span className="price-name">{quote.name}</span>
        <span className="price-now">
          {fmtPrice(quote.price)}{' '}
          <i className={up ? 'up' : 'down'} aria-hidden>
            {up ? '▲' : '▼'}
          </i>{' '}
          {fmtPct(quote.changePct)}
        </span>
      </div>
      <svg
        width={w}
        height={h}
        role="img"
        aria-label={`${quote.symbol} today, ${fmtPrice(quote.price)} ${quote.currency}, ${fmtPct(quote.changePct)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {prev !== null && (
          <line className="price-prev" x1={pad.l} x2={w - pad.r} y1={y(prev)} y2={y(prev)} />
        )}
        <path className="price-area" d={area} />
        <path className="price-line" d={line} />
        <text className="price-axis" x={w - pad.r + 6} y={y(hi) + 4}>
          {fmtPrice(hi)}
        </text>
        <text className="price-axis" x={w - pad.r + 6} y={y(lo) + 4}>
          {fmtPrice(lo)}
        </text>
        {pts.length > 1 && (
          <>
            <text className="price-axis" x={pad.l} y={h - 4}>
              {time(t0)}
            </text>
            <text className="price-axis" x={w - pad.r} y={h - 4} textAnchor="end">
              {time(t1)}
            </text>
          </>
        )}
        {hp && (
          <g className="price-hover">
            <line x1={x(hp[0])} x2={x(hp[0])} y1={pad.t} y2={h - pad.b} />
            <circle cx={x(hp[0])} cy={y(hp[1])} r={4} />
            <text x={Math.min(x(hp[0]) + 8, w - pad.r - 70)} y={pad.t + 12}>
              {fmtPrice(hp[1])} · {time(hp[0])}
            </text>
          </g>
        )}
      </svg>
      <span className="price-source">{quote.source}</span>
    </div>
  )
}

// ---------------------------------------------------------------- headlines

function ago(t: number | null) {
  if (!t) return ''
  const mins = Math.round((Date.now() - t) / 60_000)
  if (mins < 60) return `${Math.max(1, mins)}m`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function HeadlinesTab() {
  const filter = useStore((s) => s.media.filter)
  const [items, setItems] = useState<Headline[] | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      api<Headline[]>('/dash/headlines')
        .then((h) => alive && setItems(h))
        .catch(() => alive && setItems([]))
    load()
    const id = window.setInterval(load, 10 * 60_000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (items ?? [])
    .filter((h) => !words.length || words.some((w) => h.title.toLowerCase().includes(w)))
    .slice(0, 16)

  // Opens in JARVIS's own article reader, which sits in this panel on the dash.
  const open = (h: Headline) =>
    useStore.getState().pushBlade({
      id: `h${Date.now().toString(36)}`,
      title: h.source.toUpperCase(),
      kind: 'article',
      url: h.link,
      mode: 'reader',
      size: 'tall',
      hold: 'turn',
    })

  return (
    <div className="media-headlines">
      {filter && (
        <button type="button" className="media-filter" onClick={() => useStore.getState().setMedia({ filter: '' })}>
          “{filter}” ×
        </button>
      )}
      {items === null ? (
        <p className="media-note">Loading…</p>
      ) : shown.length ? (
        <ol>
          {shown.map((h) => (
            <li key={h.link}>
              <button type="button" onClick={() => open(h)}>
                <span className="media-src">
                  {h.short}
                  {h.time ? ` · ${ago(h.time)}` : ''}
                </span>
                <span className="media-title">{h.title}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="media-note">{filter ? `No headlines mention “${filter}”.` : 'No headlines right now.'}</p>
      )}
    </div>
  )
}
