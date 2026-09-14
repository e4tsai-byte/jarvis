import { useEffect, useRef, useState } from 'react'
import { useStore, type Range } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { saveWatchlist } from '../lib/watchlist'

/**
 * The media hub: live news, markets and headlines, bottom-right of the
 * dashboard — or, expanded, the whole screen with JARVIS docked top-right as
 * he is over the globe. Every request goes to the bridge, which does the
 * fetching; JARVIS switches tabs, views, channels and symbols by voice through
 * the same store the controls write to.
 */

type Media = ReturnType<typeof useStore.getState>['media']
type Channel = { id: string; name: string; short: string }
type Quote = {
  symbol: string
  name: string
  price: number
  /** What the range's change is measured from: yesterday's close for 1D,
   *  the close before the range began otherwise. */
  base: number | null
  change: number | null
  changePct: number | null
  currency: string
  points: [number, number][]
  range: Range
  source: string
}
type QuoteOf = (symbol: string) => Quote | 'error' | undefined
type Headline = {
  title: string
  link: string
  source: string
  short: string
  channel: string
  time: number | null
  image: string | null
}
type Stat = { label: string; value: string; key: boolean }
type Match = { symbol: string; name: string; kind: 'stock' | 'fund' | 'crypto' }

const YT = 'https://www.youtube-nocookie.com'
const TABS = [
  ['live', 'Live'],
  ['markets', 'Markets'],
  ['headlines', 'Headlines'],
] as const
const VIEWS = [
  ['gallery', 'Gallery'],
  ['compare', 'Compare'],
  ['single', 'Single'],
] as const
const RANGES = [
  ['1D', '1D'],
  ['5D', '5D'],
  ['1M', '1M'],
  ['1Y', '1Y'],
] as const
const LIVE_VIEWS = [
  ['wall', 'All channels'],
  ['single', 'One channel'],
] as const
const WATCH_MAX = 9
const COMPARE_MAX = 6
/**
 * Compare's line colours: the dataviz reference's eight categorical slots in
 * their dark steps, validated on this hub's surface (every adjacent pair clears
 * the colour-blind target, all clear 3:1). A stock keeps its colour whatever
 * else is drawn — it follows the stock's place on the list, never its rank.
 */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']

const api = <T,>(path: string): Promise<T> =>
  fetch(`${BRIDGE_HTTP_URL}${path}`, { signal: AbortSignal.timeout(12_000) }).then((r) =>
    r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status))),
  )
/** Remote pictures come through the bridge, the only image host the page's
 *  CSP allows. */
const viaBridge = (url: string) => `${BRIDGE_HTTP_URL}/img?url=${encodeURIComponent(url)}`
const setMedia = (patch: Partial<Media>) => useStore.getState().setMedia(patch)
const label = (symbol: string) => symbol.replace(/-USD$/, '')

export function MediaHub() {
  const tab = useStore((s) => s.media.tab)
  const full = useStore((s) => s.layout === 'media')
  return (
    <section className={`dash-slot dash-media${full ? ' is-full' : ''}`} data-slot="media">
      <header className="media-head">
        <nav className="media-tabs" role="tablist" aria-label="Media">
          {TABS.map(([id, text]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setMedia({ tab: id })}>
              {text}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="media-expand"
          onClick={() => useStore.getState().setLayout(full ? 'dash' : 'media')}
        >
          {full ? 'Back to dash · Esc' : 'Expand ⤢'}
        </button>
      </header>
      <div className="media-body">
        {tab === 'live' && <LiveTab full={full} />}
        {tab === 'markets' && <MarketsTab full={full} />}
        {tab === 'headlines' && <HeadlinesTab full={full} />}
      </div>
    </section>
  )
}

/** A few mutually exclusive options in one row, like the tabs above them. */
function Segmented<T extends string>({
  label: name,
  options,
  value,
  onChange,
}: {
  label: string
  options: ReadonlyArray<readonly [T, string]>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="media-seg" role="group" aria-label={name}>
      {options.map(([id, text]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  )
}

function useChannels() {
  const [channels, setChannels] = useState<Channel[]>([])
  useEffect(() => {
    api<Channel[]>('/dash/channels').then(setChannels).catch(() => {})
  }, [])
  return channels
}

// --------------------------------------------------------------------- live

type LiveVideo = { name: string; videoId: string | null; live?: boolean }

/**
 * One channel's live stream. Muted unless it is the one with sound — and never
 * talking over the user holding Space or JARVIS speaking.
 */
function Player({ id, audible, controls = true }: { id: string; audible: boolean; controls?: boolean }) {
  const phase = useStore((s) => s.phase)
  const [video, setVideo] = useState<LiveVideo | null>(null)
  const [error, setError] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let alive = true
    setVideo(null)
    setError('')
    api<LiveVideo>(`/dash/live?channel=${encodeURIComponent(id)}`)
      .then((v) => alive && setVideo(v))
      .catch(() => alive && setError('That channel could not be reached.'))
    return () => {
      alive = false
    }
  }, [id])

  const quiet = !audible || phase === 'listening' || phase === 'speaking'
  const videoId = video?.live === false ? null : (video?.videoId ?? null)

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
  }, [quiet, videoId])

  if (!videoId) {
    return (
      <p className="media-note">
        {error || (video ? `${video.name} is not live right now.` : 'Tuning in…')}
      </p>
    )
  }
  const src =
    `${YT}/embed/${videoId}?autoplay=1&mute=1&enablejsapi=1&playsinline=1&rel=0` +
    `${controls ? '' : '&controls=0'}&origin=${encodeURIComponent(window.location.origin)}`
  return (
    <iframe
      ref={frame}
      src={src}
      title={`${video?.name ?? 'News'} live`}
      allow="autoplay; encrypted-media; picture-in-picture"
    />
  )
}

function LiveTab({ full }: { full: boolean }) {
  const channel = useStore((s) => s.media.channel)
  const sound = useStore((s) => s.media.sound)
  const liveView = useStore((s) => s.media.liveView)
  const channels = useChannels()
  // The wall needs the room, so it is a full-screen thing; the box on the
  // dash always plays one channel.
  const wall = full && liveView === 'wall'

  return (
    <div className="media-live">
      {full && (
        <div className="media-tools">
          <Segmented label="Live view" options={LIVE_VIEWS} value={liveView} onChange={(v) => setMedia({ liveView: v })} />
        </div>
      )}
      {wall ? (
        <div className="live-wall">
          {channels.map((c) => {
            const audible = sound && c.id === channel
            return (
              <div key={c.id} className={`wall-tile${audible ? ' is-audible' : ''}`}>
                <Player id={c.id} audible={audible} controls={false} />
                <button
                  type="button"
                  className="wall-open"
                  onClick={() => setMedia({ liveView: 'single', channel: c.id })}
                  aria-label={`Watch ${c.name} on its own`}
                />
                <span className="wall-name">{c.name}</span>
                <button
                  type="button"
                  className="wall-sound"
                  aria-pressed={audible}
                  onClick={() => setMedia(audible ? { sound: false } : { channel: c.id, sound: true })}
                  title={audible ? `Mute ${c.name}` : `Listen to ${c.name}`}
                >
                  {audible ? '🔊' : '🔈'}
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <>
          <div className="media-screen">
            <Player id={channel} audible={sound} />
          </div>
          <div className="media-row">
            {channels.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.name}
                className={c.id === channel ? 'on' : ''}
                onClick={() => setMedia({ tab: 'live', channel: c.id })}
              >
                {c.short}
              </button>
            ))}
            <button
              type="button"
              className={`media-sound${sound ? ' on' : ''}`}
              aria-pressed={sound}
              onClick={() => setMedia({ sound: !sound })}
            >
              {sound ? 'Sound on' : 'Muted'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ markets

const fmtPrice = (v: number) =>
  v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2)
const fmtPct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`)

/** A time on a chart, as precise as its range needs. */
function when(t: number, range: Range, detail = false) {
  const d = new Date(t)
  if (range === '1D') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (range === '5D') {
    return detail
      ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })
  }
  if (range === '1M') return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return detail
    ? d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    : d.toLocaleDateString([], { month: 'short', year: 'numeric' })
}

/** The arrow carries the direction; the number stays in text ink. */
function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="mk-change">—</span>
  const up = pct >= 0
  return (
    <span className="mk-change">
      <i className={up ? 'up' : 'down'} aria-hidden>
        {up ? '▲' : '▼'}
      </i>{' '}
      {fmtPct(pct)}
    </span>
  )
}

/** Quotes for a set of symbols over a range, kept fresh: today's every
 *  minute, longer ranges every ten. */
function useQuotes(symbols: string[], range: Range): QuoteOf {
  const [quotes, setQuotes] = useState<Record<string, Quote | 'error'>>({})
  const key = symbols.join(',')
  useEffect(() => {
    let alive = true
    const list = key ? key.split(',') : []
    const load = () =>
      list.forEach((s) =>
        api<Quote>(`/dash/market?symbol=${encodeURIComponent(s)}&range=${range}`)
          .then((q) => alive && setQuotes((p) => ({ ...p, [`${s}|${range}`]: q })))
          .catch(() => alive && setQuotes((p) => ({ ...p, [`${s}|${range}`]: 'error' }))),
      )
    load()
    const id = window.setInterval(load, range === '1D' ? 60_000 : 10 * 60_000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [key, range])
  return (s) => quotes[`${s}|${range}`]
}

function MarketsTab({ full }: { full: boolean }) {
  const view = useStore((s) => s.media.view)
  const oneOff = useStore((s) => s.media.oneOff)
  const picked = useStore((s) => s.media.symbol)
  const watch = useStore((s) => s.watchlist)
  const range = watch.range
  // A one-off set JARVIS was asked for stands in for the watchlist, unsaved.
  const temporary = oneOff.length > 0
  const shown = temporary ? oneOff : watch.symbols
  const drawn = temporary ? oneOff : watch.compare.filter((s) => watch.symbols.includes(s))
  const single = picked || shown[0] || ''
  const quote = useQuotes(view === 'single' ? (single ? [single] : []) : shown, range)

  const colorOf = (s: string) => {
    const i = shown.indexOf(s)
    if (i >= 0 && i < SERIES.length) return SERIES[i]
    // A ninth stock wears whichever colour nothing else on the chart is.
    const worn = new Set(drawn.filter((d) => d !== s).map((d) => SERIES[shown.indexOf(d)]))
    return SERIES.find((c) => !worn.has(c)) ?? SERIES[0]
  }

  return (
    <div className="media-markets">
      <div className="media-tools">
        <Segmented label="Markets view" options={VIEWS} value={view} onChange={(v) => setMedia({ view: v })} />
        <Segmented label="Range" options={RANGES} value={range} onChange={(r) => void saveWatchlist({ range: r })} />
        {temporary && (
          <button
            type="button"
            className="media-chip is-note"
            onClick={() => setMedia({ oneOff: [] })}
            title="Back to your watchlist"
          >
            One-off: {oneOff.map(label).join(', ')} ✕
          </button>
        )}
      </div>
      {view === 'gallery' && <Gallery symbols={shown} quote={quote} editable={!temporary} />}
      {view === 'compare' && (
        <Compare chips={shown} drawn={drawn} quote={quote} colorOf={colorOf} editable={!temporary} range={range} />
      )}
      {view === 'single' && (
        <Single
          symbol={single}
          quote={quote}
          full={full}
          choices={!single || shown.includes(single) ? shown : [single, ...shown]}
        />
      )}
    </div>
  )
}

/** A box per stock, like a gallery of videos. Click one for Single. */
function Gallery({ symbols, quote, editable }: { symbols: string[]; quote: QuoteOf; editable: boolean }) {
  const watch = useStore((s) => s.watchlist)
  return (
    <div className="mk-gallery">
      {symbols.map((s) => {
        const q = quote(s)
        return (
          <div key={s} className="mk-box">
            <button
              type="button"
              className="mk-box-open"
              onClick={() => setMedia({ view: 'single', symbol: s })}
              title={`Open ${label(s)} on its own`}
            >
              <span className="mk-box-head">
                <b>{label(s)}</b>
                {q && q !== 'error' && (
                  <span className="mk-now">
                    {fmtPrice(q.price)} <Change pct={q.changePct} />
                  </span>
                )}
              </span>
              <span className="mk-box-chart">
                {q && q !== 'error' ? (
                  <PriceChart quote={q} compact />
                ) : (
                  <span className="media-note">{q === 'error' ? 'No data right now.' : 'Loading…'}</span>
                )}
              </span>
            </button>
            {editable && (
              <button
                type="button"
                className="mk-remove"
                onClick={() => void saveWatchlist({ symbols: watch.symbols.filter((x) => x !== s) })}
                title={`Remove ${label(s)} from your watchlist`}
                aria-label={`Remove ${label(s)} from your watchlist`}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
      {editable && symbols.length < WATCH_MAX && <AddBox />}
    </div>
  )
}

/** The + box: search by ticker or company name, pick one to add it. */
function AddBox() {
  const watch = useStore((s) => s.watchlist)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [matches, setMatches] = useState<Match[] | null>(null)

  useEffect(() => {
    const term = q.trim()
    if (!open || !term) {
      setMatches(null)
      return
    }
    let alive = true
    const t = window.setTimeout(() => {
      api<Match[]>(`/dash/search?q=${encodeURIComponent(term)}`)
        .then((m) => alive && setMatches(m))
        .catch(() => alive && setMatches([]))
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [q, open])

  const close = () => {
    setOpen(false)
    setQ('')
    setMatches(null)
  }
  const add = (symbol: string) => {
    void saveWatchlist({ symbols: [...watch.symbols, symbol] })
    close()
  }
  const fresh = (matches ?? []).filter((m) => !watch.symbols.includes(m.symbol))

  if (!open) {
    return (
      <button type="button" className="mk-box mk-add" onClick={() => setOpen(true)}>
        <span aria-hidden>+</span>
        Add a stock
      </button>
    )
  }
  return (
    <div className="mk-box mk-add is-open">
      <input
        autoFocus
        className="mk-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Ticker or company"
        aria-label="Search for a stock to add"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          } else if (e.key === 'Enter' && fresh[0]) {
            e.preventDefault()
            add(fresh[0].symbol)
          }
        }}
        onBlur={() => window.setTimeout(close, 150)}
      />
      {matches !== null && (
        <ul className="mk-matches">
          {fresh.length ? (
            fresh.map((m) => (
              <li key={m.symbol}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(m.symbol)}>
                  <b>{label(m.symbol)}</b>
                  <span>{m.name}</span>
                  <i>{m.kind}</i>
                </button>
              </li>
            ))
          ) : (
            <li className="media-note">No match.</li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Several stocks on one chart. Tap a chip to draw or drop its line. */
function Compare({
  chips,
  drawn,
  quote,
  colorOf,
  editable,
  range,
}: {
  chips: string[]
  drawn: string[]
  quote: QuoteOf
  colorOf: (s: string) => string
  editable: boolean
  range: Range
}) {
  const toggle = (s: string) => {
    if (!editable) return
    const next = drawn.includes(s)
      ? drawn.filter((x) => x !== s)
      : drawn.length < COMPARE_MAX
        ? [...drawn, s]
        : drawn
    void saveWatchlist({ compare: next })
  }
  const lines: Line[] = []
  for (const s of drawn) {
    const q = quote(s)
    if (q && q !== 'error') lines.push({ symbol: s, color: colorOf(s), quote: q })
  }
  return (
    <div className="mk-compare">
      <ul className="mk-legend" aria-label="Stocks on the chart">
        {chips.map((s) => {
          const on = drawn.includes(s)
          const q = quote(s)
          return (
            <li key={s}>
              <button
                type="button"
                className={`media-chip${on ? ' on' : ''}`}
                aria-pressed={on}
                disabled={!editable || (!on && drawn.length >= COMPARE_MAX)}
                onClick={() => toggle(s)}
                title={on ? `Take ${label(s)} off the chart` : `Draw ${label(s)}`}
              >
                <i className="mk-swatch" style={{ borderColor: colorOf(s), background: on ? colorOf(s) : 'transparent' }} />
                {label(s)} <Change pct={q && q !== 'error' ? q.changePct : null} />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="mk-chart">
        {lines.length ? (
          <CompareChart lines={lines} range={range} />
        ) : (
          <p className="media-note">{drawn.length ? 'Loading…' : 'Tap a stock above to draw it.'}</p>
        )}
      </div>
    </div>
  )
}

/** One stock big, with its day at a glance underneath. */
function Single({
  symbol,
  quote,
  full,
  choices,
}: {
  symbol: string
  quote: QuoteOf
  full: boolean
  choices: string[]
}) {
  const [items, setItems] = useState<Stat[] | null>(null)
  useEffect(() => {
    let alive = true
    setItems(null)
    if (!symbol) return
    api<{ items: Stat[] }>(`/dash/stats?symbol=${encodeURIComponent(symbol)}`)
      .then((r) => alive && setItems(r.items))
      .catch(() => alive && setItems([]))
    return () => {
      alive = false
    }
  }, [symbol])
  const q = symbol ? quote(symbol) : undefined
  // The box has room for three; full screen shows them all.
  const strip = (items ?? []).filter((i) => full || i.key)
  return (
    <div className="mk-single">
      <ul className="mk-legend" aria-label="Stock">
        {choices.map((s) => (
          <li key={s}>
            <button
              type="button"
              className={`media-chip${s === symbol ? ' on' : ''}`}
              aria-pressed={s === symbol}
              onClick={() => setMedia({ symbol: s })}
            >
              {label(s)}
            </button>
          </li>
        ))}
      </ul>
      <div className="mk-chart">
        {q && q !== 'error' ? (
          <PriceChart quote={q} />
        ) : (
          <p className="media-note">{q === 'error' ? `No data for ${label(symbol)} right now.` : 'Loading…'}</p>
        )}
      </div>
      {strip.length > 0 && (
        <dl className="mk-stats">
          {strip.map((i) => (
            <div key={i.label}>
              <dt>{i.label}</dt>
              <dd>{i.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/**
 * One symbol over its range, as a line. A single series, so no legend — the
 * header or the box names it. The dashed line is what the change is measured
 * from. Hovering shows the price at that moment. `compact` is the gallery's
 * version: no axes, no header, the hover reading still there.
 */
function PriceChart({ quote, compact = false }: { quote: Quote; compact?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 320, h: 150 })
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setSize({
        w: Math.max(compact ? 80 : 160, e.contentRect.width),
        h: Math.max(compact ? 40 : 90, e.contentRect.height),
      }),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [compact])

  const pts = quote.points
  const base = quote.base
  const pad = compact ? { l: 2, r: 2, t: 6, b: 4 } : { l: 6, r: 52, t: 30, b: 18 }
  const w = size.w
  const h = size.h
  const values = pts.map((p) => p[1]).concat(base === null ? [] : [base])
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const t0 = pts[0]?.[0] ?? 0
  const t1 = pts.at(-1)?.[0] ?? 1
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b)

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('')
  const area = pts.length ? `${line}L${x(t1).toFixed(1)},${h - pad.b}L${x(t0).toFixed(1)},${h - pad.b}Z` : ''

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
    <div className={`price-chart${compact ? ' is-compact' : ''}`} ref={box}>
      {!compact && (
        <div className="price-head">
          <b>{label(quote.symbol)}</b>
          <span className="price-name">{quote.name}</span>
          <span className="price-now">
            {fmtPrice(quote.price)}{' '}
            <i className={up ? 'up' : 'down'} aria-hidden>
              {up ? '▲' : '▼'}
            </i>{' '}
            {fmtPct(quote.changePct)}
          </span>
        </div>
      )}
      <svg
        width={w}
        height={h}
        role="img"
        aria-label={`${label(quote.symbol)} over ${quote.range}, ${fmtPrice(quote.price)} ${quote.currency}, ${fmtPct(quote.changePct)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {base !== null && <line className="price-prev" x1={pad.l} x2={w - pad.r} y1={y(base)} y2={y(base)} />}
        <path className="price-area" d={area} />
        <path className="price-line" d={line} />
        {!compact && (
          <>
            <text className="price-axis" x={w - pad.r + 6} y={y(hi) + 4}>
              {fmtPrice(hi)}
            </text>
            <text className="price-axis" x={w - pad.r + 6} y={y(lo) + 4}>
              {fmtPrice(lo)}
            </text>
            {pts.length > 1 && (
              <>
                <text className="price-axis" x={pad.l} y={h - 4}>
                  {when(t0, quote.range)}
                </text>
                <text className="price-axis" x={w - pad.r} y={h - 4} textAnchor="end">
                  {when(t1, quote.range)}
                </text>
              </>
            )}
          </>
        )}
        {hp && (
          <g className="price-hover">
            <line x1={x(hp[0])} x2={x(hp[0])} y1={pad.t} y2={h - pad.b} />
            <circle cx={x(hp[0])} cy={y(hp[1])} r={compact ? 3 : 4} />
            <text x={Math.max(pad.l, Math.min(x(hp[0]) + 8, w - (compact ? 110 : pad.r + 110)))} y={pad.t + 11}>
              {fmtPrice(hp[1])} · {when(hp[0], quote.range, true)}
            </text>
          </g>
        )}
      </svg>
      {!compact && <span className="price-source">{quote.source}</span>}
    </div>
  )
}

type Line = { symbol: string; color: string; quote: Quote }

/** Labels that want to sit at `want`, moved apart until `gap` pixels
 *  separate each, and kept between `top` and `bottom`. */
function spread<T extends { want: number }>(items: T[], gap: number, top: number, bottom: number) {
  const out = [...items].sort((a, b) => a.want - b.want).map((i) => ({ ...i, y: i.want }))
  for (let i = 1; i < out.length; i++) out[i].y = Math.max(out[i].y, out[i - 1].y + gap)
  const over = (out.at(-1)?.y ?? 0) - bottom
  if (over > 0) for (const o of out) o.y -= over
  for (let i = out.length - 2; i >= 0; i--) out[i].y = Math.min(out[i].y, out[i + 1].y - gap)
  for (const o of out) o.y = Math.max(top, o.y)
  return out
}

/**
 * Several stocks on one chart, each as % change from where its range began:
 * a $77,000 coin and a $200 stock cannot share a price axis, but they can
 * share a percentage. The chips above name every line; with four or fewer each
 * is also labelled at its end, so colour never carries identity alone.
 * Hovering reads every line at that moment.
 */
function CompareChart({ lines, range }: { lines: Line[]; range: Range }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 480, h: 220 })
  const [hoverX, setHoverX] = useState<number | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(110, e.contentRect.height) }),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const series = lines
    .map((l) => {
      const base = l.quote.base ?? l.quote.points[0]?.[1] ?? l.quote.price
      const pts = l.quote.points.map(([t, v]) => [t, ((v - base) / base) * 100] as [number, number])
      return { ...l, pts }
    })
    .filter((s) => s.pts.length > 1)

  const labelled = series.length <= 4
  // Room on the left for a seven-character label like "−11.32%".
  const pad = { l: 60, r: labelled ? 92 : 12, t: 12, b: 20 }
  const w = size.w
  const h = size.h
  const ts = series.flatMap((s) => s.pts.map((p) => p[0]))
  const vs = series.flatMap((s) => s.pts.map((p) => p[1]))
  const t0 = ts.length ? Math.min(...ts) : 0
  const t1 = ts.length ? Math.max(...ts) : 1
  const lo = Math.min(0, ...vs)
  const hi = Math.max(0, ...vs)
  const span = hi - lo || 1
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b)
  const path = (pts: [number, number][]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('')

  const ends = labelled
    ? spread(
        series.map((s) => {
          const last = s.pts[s.pts.length - 1]
          return { key: s.symbol, color: s.color, want: y(last[1]), end: [x(last[0]), y(last[1])] as const, text: `${label(s.symbol)} ${fmtPct(last[1])}` }
        }),
        13,
        pad.t + 4,
        h - pad.b,
      )
    : []

  const at = hoverX === null ? null : t0 + ((hoverX - pad.l) / (w - pad.l - pad.r)) * (t1 - t0)
  const readings =
    at === null
      ? []
      : series
          .map((s) => {
            let best = s.pts[0]
            for (const p of s.pts) if (Math.abs(p[0] - at) < Math.abs(best[0] - at)) best = p
            return { symbol: s.symbol, color: s.color, t: best[0], v: best[1] }
          })
          .sort((a, b) => b.v - a.v)

  // Axis labels for the extremes only when they are not crowding the 0% one.
  const showHi = y(hi) < y(0) - 12
  const showLo = y(lo) > y(0) + 12

  return (
    <div className="price-chart cmp-chart" ref={box}>
      {series.length === 0 ? (
        <p className="media-note">No data for these yet.</p>
      ) : (
        <svg
          width={w}
          height={h}
          role="img"
          aria-label={`${series.map((s) => label(s.symbol)).join(', ')}: % change over ${range}`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setHoverX(Math.max(pad.l, Math.min(w - pad.r, e.clientX - r.left)))
          }}
          onPointerLeave={() => setHoverX(null)}
        >
          <line className="price-prev" x1={pad.l} x2={w - pad.r} y1={y(0)} y2={y(0)} />
          <text className="price-axis" x={pad.l - 6} y={y(0) + 4} textAnchor="end">
            0%
          </text>
          {showHi && (
            <text className="price-axis" x={pad.l - 6} y={y(hi) + 4} textAnchor="end">
              {fmtPct(hi)}
            </text>
          )}
          {showLo && (
            <text className="price-axis" x={pad.l - 6} y={y(lo) + 4} textAnchor="end">
              {fmtPct(lo)}
            </text>
          )}
          <text className="price-axis" x={pad.l} y={h - 4}>
            {when(t0, range)}
          </text>
          <text className="price-axis" x={w - pad.r} y={h - 4} textAnchor="end">
            {when(t1, range)}
          </text>
          {series.map((s) => (
            <path key={s.symbol} className="cmp-line" d={path(s.pts)} style={{ stroke: s.color }} />
          ))}
          {ends.map((e) => (
            <g key={e.key}>
              <polyline
                className="cmp-leader"
                points={`${e.end[0]},${e.end[1]} ${w - pad.r + 4},${e.y} ${w - pad.r + 10},${e.y}`}
                style={{ stroke: e.color }}
              />
              <text className="cmp-end" x={w - pad.r + 13} y={e.y + 3.5}>
                {e.text}
              </text>
            </g>
          ))}
          {hoverX !== null && (
            <g className="price-hover">
              <line x1={hoverX} x2={hoverX} y1={pad.t} y2={h - pad.b} />
              {readings.map((r) => (
                <circle key={r.symbol} cx={x(r.t)} cy={y(r.v)} r={3.5} style={{ fill: r.color }} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hoverX !== null && at !== null && readings.length > 0 && (
        <div className="cmp-tip" style={{ left: Math.max(4, Math.min(hoverX + 12, w - 160)), top: pad.t }}>
          <b>{when(at, range, true)}</b>
          {readings.map((r) => (
            <span key={r.symbol}>
              <i style={{ background: r.color }} />
              {label(r.symbol)} {fmtPct(r.v)}
            </span>
          ))}
        </div>
      )}
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

/** Opens in JARVIS's own reader, which sits over the hub and has its own way
 *  out to the original. */
const read = (h: Headline) =>
  useStore.getState().pushBlade({
    id: `h${Date.now().toString(36)}`,
    title: h.source.toUpperCase(),
    kind: 'article',
    url: h.link,
    mode: 'reader',
    size: 'tall',
    hold: 'turn',
  })

function HeadlinesTab({ full }: { full: boolean }) {
  const filter = useStore((s) => s.media.filter)
  const channels = useChannels()
  const [only, setOnly] = useState<string | null>(null)
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
  const shown = (items ?? []).filter(
    (h) => (!only || h.channel === only) && (!words.length || words.some((w) => h.title.toLowerCase().includes(w))),
  )

  return (
    <div className="media-headlines">
      <div className="media-tools" role="group" aria-label="Channels">
        <button type="button" className={`media-chip${only ? '' : ' on'}`} aria-pressed={!only} onClick={() => setOnly(null)}>
          All
        </button>
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`media-chip${only === c.id ? ' on' : ''}`}
            aria-pressed={only === c.id}
            title={c.name}
            onClick={() => setOnly(only === c.id ? null : c.id)}
          >
            {c.short}
          </button>
        ))}
        {filter && (
          <button
            type="button"
            className="media-chip on is-note"
            onClick={() => setMedia({ filter: '' })}
            title="Clear JARVIS's topic filter"
          >
            “{filter}” ✕
          </button>
        )}
      </div>
      {items === null ? (
        <p className="media-note">Loading…</p>
      ) : shown.length ? (
        <div className={`hl-grid${full ? ' is-wide' : ''}`}>
          {shown.map((h) => (
            <HeadlineCard key={h.link} story={h} />
          ))}
        </div>
      ) : (
        <p className="media-note">
          {filter ? `No headlines mention “${filter}”.` : only ? 'Nothing from that channel right now.' : 'No headlines right now.'}
        </p>
      )}
    </div>
  )
}

/**
 * A story the way a video sits in a feed: its picture, the headline under it,
 * who and how long ago. The channel's tile shows until the picture arrives, or
 * instead of one the story does not have.
 */
function HeadlineCard({ story }: { story: Headline }) {
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState(false)
  return (
    <article className="hl-card">
      <button type="button" className="hl-open" onClick={() => read(story)}>
        <span className="hl-thumb">
          <span className="hl-tile" aria-hidden>
            {story.short}
          </span>
          {story.image && !broken && (
            <img
              src={viaBridge(story.image)}
              alt=""
              loading="lazy"
              decoding="async"
              className={loaded ? 'is-loaded' : ''}
              onLoad={() => setLoaded(true)}
              onError={() => setBroken(true)}
            />
          )}
          {loaded && <span className="hl-badge">{story.short}</span>}
        </span>
        <span className="hl-title">{story.title}</span>
        <span className="hl-meta">
          {story.source}
          {story.time ? ` · ${ago(story.time)} ago` : ''}
        </span>
      </button>
      {/^https?:\/\//i.test(story.link) && (
        <a
          className="hl-original"
          href={story.link}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open the original on ${story.source}`}
          aria-label={`Open the original story on ${story.source}`}
        >
          ↗
        </a>
      )}
    </article>
  )
}
