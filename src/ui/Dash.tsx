import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore, accentFor } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { statusText } from './status'
import { MediaHub } from './MediaHub'
import { DecodeText } from './Hud'
import './dash.css'

/**
 * The dashboard: everything at once.
 *
 * JARVIS's half is one lit field: the reactor floating at its centre, his
 * readouts around it on traces that flow out of it, the conversation
 * underneath, and the reactor's dust behind all of it. The right-hand column is the globe and the
 * media hub, which are windows onto something else and so are framed.
 *
 * The reactor and the globe are not rendered here. The reactor is the
 * full-screen canvas it always was, and the scene's camera frames the orb on
 * the panel measured below; the globe is the iframe it always was, moved into
 * its panel by a transform. That is what keeps the switch to the full-screen
 * world view an animation of the same two elements — nothing reflows, the
 * globe never reloads.
 */

type Telemetry = {
  cpu: number
  memory: { used: number; total: number }
  network: { rxPerSec: number; txPerSec: number } | null
  load: number
  uptime: number
}

/** The reactor's outer ring, as a share of the viewport height at zoom 1. */
const RING_VH = 0.58
/** How much of the panel's orb space the ring fills, by height and by width. */
const RING_FILL = 0.72
const RING_WIDTH_FILL = 0.8
/** The scene sits the ring a little above the middle of its slot — 2vh at
 *  zoom 1 — here as a share of the ring's diameter. */
const RING_LIFT = 0.02 / RING_VH
/** Where the traces leave the orb, as a multiple of the ring's radius: just
 *  outside its glow, among the instrument rings. */
const TRACE_START = 1.12
/** The world view's orb: its radius and its margin from the top-right corner.
 *  .world-orb-hit in index.css is the same circle. */
const ORB_RADIUS_PX = 70
const ORB_MARGIN = 22
/** The orb's crop around the ring at zoom 1, as a share of the viewport
 *  height; the ring spans 0.58, so this keeps a sliver of its glow. */
const ORB_CLIP_VH = 0.3
/** Network samples in the traffic trace: a minute, at one every two seconds. */
const TRAFFIC_SAMPLES = 30

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)
const rate = (bps: number) =>
  bps >= 1024 ** 2 ? `${(bps / 1024 ** 2).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`
const since = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`
}

/**
 * Measure the slots and publish what everything placed from outside needs:
 * the reactor's framing for the scene camera (through the store) and for the
 * instrument rings (CSS variables), where the world view's orb docks, the
 * right edge of JARVIS's half for the reactor's soft edge, and the boxes the
 * HUD's typing bar, caption and JARVIS's panels are placed in.
 */
function measure() {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const root = document.documentElement.style
  const px = (name: string, v: number) => root.setProperty(name, `${v}px`)
  const rect = (name: string) => document.querySelector(`[data-slot="${name}"]`)?.getBoundingClientRect()
  const box = (name: string, r: DOMRect) => {
    px(`--${name}-x`, r.left)
    px(`--${name}-y`, r.top)
    px(`--${name}-w`, r.width)
    px(`--${name}-h`, r.height)
    px(`--${name}-bottom`, vh - r.bottom)
  }

  const jarvis = rect('jarvis')
  if (jarvis) px('--jarvis-right', jarvis.right)

  const reactor = rect('reactor')
  if (reactor) {
    box('reactor', reactor)
    const cx = reactor.left + reactor.width / 2
    const cy = reactor.top + reactor.height / 2
    const ring = Math.min(RING_FILL * reactor.height, RING_WIDTH_FILL * reactor.width)
    const k = ring / (RING_VH * vh)
    const tx = cx - vw / 2
    const ty = cy - vh / 2
    px('--reactor-cx', cx)
    px('--reactor-cy', cy)
    px('--reactor-tx', tx)
    px('--reactor-ty', ty)
    root.setProperty('--reactor-s', String(k))
    const s = useStore.getState()
    const f = s.reactorFrame
    if (!f || Math.abs(f.tx - tx) > 0.5 || Math.abs(f.ty - ty) > 0.5 || Math.abs(f.k - k) > 0.001) {
      s.setReactorFrame({ tx, ty, k })
    }

    // The world view carries this same spot to the top-right corner and crops
    // it to a circle around the ring.
    const r = ORB_CLIP_VH * vh * k
    px('--orb-tx', vw - ORB_MARGIN - ORB_RADIUS_PX - cx)
    px('--orb-ty', ORB_MARGIN + ORB_RADIUS_PX - cy)
    root.setProperty('--orb-scale', String(ORB_RADIUS_PX / r))
    root.setProperty('--orb-clip', `${cy - r}px ${vw - cx - r}px ${vh - cy - r}px ${cx - r}px`)
  }

  // Cover, not contain: GEV draws its globe as a circle the height of the
  // viewport, so fitting the height frames the globe and the crop only takes
  // the empty sides.
  const world = rect('world')
  if (world) {
    const s = Math.max(world.width / vw, world.height / vh)
    px('--world-tx', world.left + world.width / 2 - vw / 2)
    px('--world-ty', world.top + world.height / 2 - vh / 2)
    root.setProperty('--world-s', String(s))
    root.setProperty(
      '--world-clip',
      `${Math.max(0, (vh - world.height / s) / 2)}px ${Math.max(0, (vw - world.width / s) / 2)}px`,
    )
    px('--world-r', 4 / s)
  }
  const convo = rect('convo')
  if (convo) box('convo', convo)
  const media = rect('media')
  if (media) box('media', media)
}

export function Dash() {
  const phase = useStore((s) => s.phase)
  const ui = useStore((s) => s.ui)
  const layout = useStore((s) => s.layout)
  const world = useStore((s) => s.world)
  const connected = useStore((s) => s.connected)
  const personal = useStore((s) => s.personal)
  const root = useRef<HTMLDivElement>(null)
  const [stats, setStats] = useState<Telemetry | null>(null)
  const [traffic, setTraffic] = useState<number[]>([])
  const [clock, setClock] = useState(() => new Date())
  const [engine, setEngine] = useState('')
  const offline = phase === 'offline'
  // The traces carry light while he is doing something.
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

  useEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    if (root.current) ro.observe(root.current)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  // The Mac's numbers, only while they are on screen.
  useEffect(() => {
    if (layout !== 'dash' || offline) return
    let alive = true
    const load = () => {
      // The voice engine settles after boot (and can fail later), so the chip
      // reads it on the same beat as the Mac's numbers rather than once.
      const voice = (window as unknown as { __voice?: { engine?: string; running?: boolean } }).__voice
      setEngine(!voice?.running ? 'OFF' : voice.engine === 'elevenlabs' ? 'SCRIBE' : 'BROWSER')
      fetch(`${BRIDGE_HTTP_URL}/dash/telemetry`, { signal: AbortSignal.timeout(3000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((t: Telemetry | null) => {
          if (!alive || !t) return
          setStats(t)
          const net = t.network
          if (net) setTraffic((h) => [...h.slice(1 - TRAFFIC_SAMPLES), net.rxPerSec + net.txPerSec])
        })
        .catch(() => {})
    }
    load()
    const id = window.setInterval(load, 2000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [layout, offline])

  // Whatever the bridge already knows about the calendar and inbox; later
  // refreshes arrive over the socket.
  useEffect(() => {
    if (offline) return
    fetch(`${BRIDGE_HTTP_URL}/dash/personal`, { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p?.data && useStore.getState().setPersonal(p.data))
      .catch(() => {})
  }, [offline])

  const memPct = stats ? Math.round((100 * stats.memory.used) / stats.memory.total) : 0

  return (
    <div
      className="dash"
      ref={root}
      aria-hidden={layout !== 'dash'}
      data-busy={busy || undefined}
      // JARVIS's name and the traces take the phase colour, as the reactor does;
      // the readouts keep the interface cyan so they stay easy to read.
      style={{ ['--phase' as string]: accentFor(phase, ui) }}
    >
      <header className="dash-top">
        <span className={`dash-chip${world ? ' on' : ''}`}>
          WORLD · {world ? 'LINKED' : world === false ? 'SEARCHING' : 'OFF'}
        </span>
        <span className={`dash-chip${engine && engine !== 'OFF' ? ' on' : ''}`}>VOICE · {engine || '—'}</span>
        <span className={`dash-chip${phase === 'listening' ? ' on hot' : ''}`}>
          MIC · {phase === 'listening' ? 'OPEN' : 'CLOSED'}
        </span>
        <time className="dash-clock">
          {clock.toLocaleDateString([], { month: 'short', day: 'numeric' })}
          {' · '}
          {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </header>

      <section className="dash-jarvis" data-slot="jarvis">
        <Traces />

        <div className="dash-row-top">
          <div data-anchor="cpu">
            <Ring value={(stats?.cpu ?? 0) / 100} label="CPU" reading={stats ? `${stats.cpu}%` : '—'} />
          </div>
          <div className="dash-traffic" data-anchor="traffic">
            <Traffic samples={traffic} />
          </div>
          <div data-anchor="mem">
            <Ring value={memPct / 100} label="Memory" reading={stats ? `${memPct}%` : '—'} />
          </div>
        </div>

        <aside className="dash-flank dash-flank-left">
          <section className="dash-block" data-anchor="today">
            <h3 className="dash-title">Today</h3>
            <Events personal={personal} />
          </section>
          <section className="dash-block" data-anchor="inbox">
            <h3 className="dash-title">Inbox{personal?.unread ? ` · ${personal.unread.count} unread` : ''}</h3>
            <Inbox personal={personal} />
          </section>
        </aside>

        <div className="dash-core">
          <div className="dash-core-head" data-anchor="crown">
            <span className="dash-brand">J.A.R.V.I.S.</span>
            <span className="dash-status">
              <i className="dash-dot" />
              {statusText[phase]}
            </span>
          </div>
          <div className="dash-slot dash-reactor" data-slot="reactor" />
          <div className="dash-core-foot">
            <VoiceMeter />
          </div>
        </div>

        <aside className="dash-flank dash-flank-right">
          <section className="dash-block" data-anchor="machine">
            <h3 className="dash-title">Machine</h3>
            <dl className="dash-readout">
              <div>
                <dt>Memory</dt>
                <dd>{stats ? `${gb(stats.memory.used)} / ${gb(stats.memory.total)} GB` : '—'}</dd>
              </div>
              <div>
                <dt>Load</dt>
                <dd>{stats ? stats.load.toFixed(2) : '—'}</dd>
              </div>
              <div>
                <dt>Uptime</dt>
                <dd>{stats ? since(stats.uptime) : '—'}</dd>
              </div>
            </dl>
          </section>
          <section className="dash-block" data-anchor="link">
            <h3 className="dash-title">Link</h3>
            <dl className="dash-readout">
              <div>
                <dt>Down</dt>
                <dd>{stats?.network ? rate(stats.network.rxPerSec) : '—'}</dd>
              </div>
              <div>
                <dt>Up</dt>
                <dd>{stats?.network ? rate(stats.network.txPerSec) : '—'}</dd>
              </div>
              <div>
                <dt>Systems</dt>
                <dd>{connected.length} linked</dd>
              </div>
            </dl>
          </section>
        </aside>

        <div className="dash-convo" data-slot="convo">
          <div className="dash-convo-head">
            <h3 className="dash-title">Conversation</h3>
            <span className="dash-hint">hold Space to talk · Enter to type</span>
          </div>
          <Conversation />
        </div>
      </section>

      <div className="dash-right">
        <div className="dash-slot dash-world" data-slot="world">
          <span className="dash-label">World</span>
          {world ? (
            <button
              type="button"
              className="dash-expand"
              onClick={() => useStore.getState().setLayout('world')}
            >
              Expand · W
            </button>
          ) : (
            <p className="dash-offline">
              {world === false
                ? "Linking God's Eye View…"
                : "God's Eye View isn't running — start it with npm start -- --world."}
            </p>
          )}
        </div>
        <MediaHub />
      </div>
    </div>
  )
}

type Trace = { d: string; from: [number, number]; to: [number, number] }

/**
 * The traces from the orb out to each readout, drawn behind them and measured
 * off the live layout. Each leaves the orb along its own radius and eases
 * round into its readout from the side that faces the orb: up into the top
 * row, sideways into the title line of each group on the flanks, where it
 * meets the title's own hairline.
 */
function Traces() {
  const svg = useRef<SVGSVGElement>(null)
  const [traces, setTraces] = useState<Trace[]>([])
  const drawn = useRef('')

  useLayoutEffect(() => {
    // Measured against its parent, found through its own node: React sets a
    // child's refs before this effect runs, but a parent's only after.
    const el = svg.current?.parentElement
    if (!el) return
    const draw = () => {
      const o = el.getBoundingClientRect()
      const at = (name: string) => {
        const r = el.querySelector(`[data-anchor="${name}"]`)?.getBoundingClientRect()
        return r && {
          l: Math.round(r.left - o.left),
          r: Math.round(r.right - o.left),
          t: Math.round(r.top - o.top),
          b: Math.round(r.bottom - o.top),
        }
      }
      const slot = el.querySelector('[data-slot="reactor"]')?.getBoundingClientRect()
      if (!slot) return
      // Where the ring is: the middle of its slot, lifted as the scene lifts
      // it, at the size measure() fits it to.
      const ring = Math.min(RING_FILL * slot.height, RING_WIDTH_FILL * slot.width)
      const cx = slot.left - o.left + slot.width / 2
      const cy = slot.top - o.top + slot.height / 2 - ring * RING_LIFT
      const start = (ring / 2) * TRACE_START
      const crown = at('crown')
      const next: Trace[] = []

      // One run: out of the orb along its own radius, then easing round to
      // arrive travelling in `arrive`, so it lands square on the readout.
      // `bend` turns the starting radius away from the straight line, so a
      // readout almost level with the orb still gets a curve rather than a
      // stub.
      const flow = (tx: number, ty: number, arrive: [number, number], bend = 0) => {
        let angle = Math.atan2(ty - cy, tx - cx) + bend
        let sx = cx + Math.cos(angle) * start
        let sy = cy + Math.sin(angle) * start
        // Straight up would run through JARVIS's name, so that one rises from
        // just above it instead.
        if (crown && Math.abs(angle + Math.PI / 2) < 0.35) {
          angle = -Math.PI / 2
          sx = cx
          sy = crown.t - 6
        }
        const reach = Math.hypot(tx - sx, ty - sy) * 0.45
        const c1x = sx + Math.cos(angle) * reach
        const c1y = sy + Math.sin(angle) * reach
        const c2x = tx - arrive[0] * reach
        const c2y = ty - arrive[1] * reach
        const n = (v: number) => v.toFixed(1)
        next.push({
          d: `M${n(sx)},${n(sy)} C${n(c1x)},${n(c1y)} ${n(c2x)},${n(c2y)} ${n(tx)},${n(ty)}`,
          from: [sx, sy],
          to: [tx, ty],
        })
      }

      for (const name of ['cpu', 'traffic', 'mem']) {
        const a = at(name)
        if (a) flow((a.l + a.r) / 2, a.b + 6, [0, -1])
      }
      // The flanks sit nearly level with the orb, so their runs leave about
      // 20° further up or down than straight at them — up for the groups
      // above its middle, down for those below — and sweep round in.
      const side = (name: string, left: boolean) => {
        const a = at(name)
        if (!a) return
        const ty = a.t + 5
        const bend = 0.35 * Math.sign(ty - cy) * (left ? -1 : 1)
        flow(left ? a.r + 4 : a.l - 8, ty, [left ? -1 : 1, 0], bend)
      }
      side('today', true)
      side('inbox', true)
      side('machine', false)
      side('link', false)

      const key = next.map((t) => t.d).join('|')
      if (key !== drawn.current) {
        drawn.current = key
        setTraces(next)
      }
    }
    draw()
    // Every anchor, not just the host: a group growing when the calendar
    // arrives moves the others without changing the host's size.
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    el.querySelectorAll('[data-anchor], [data-slot="reactor"]').forEach((n) => ro.observe(n))
    return () => ro.disconnect()
  }, [])

  return (
    <svg className="dash-traces" ref={svg} aria-hidden>
      <defs>
        {/* Lit at the orb, fading toward the readout it feeds. */}
        {traces.map((t, i) => (
          <linearGradient
            key={i}
            id={`dash-trace-${i}`}
            gradientUnits="userSpaceOnUse"
            x1={t.from[0]}
            y1={t.from[1]}
            x2={t.to[0]}
            y2={t.to[1]}
          >
            <stop offset="0" className="trace-core" />
            <stop offset="1" className="trace-edge" />
          </linearGradient>
        ))}
      </defs>
      {traces.map((t, i) => (
        <g key={i}>
          <path className="trace" d={t.d} stroke={`url(#dash-trace-${i})`} />
          <path
            className="trace-pulse"
            d={t.d}
            pathLength={100}
            style={{ animationDelay: `${((i * 0.37) % 1.4).toFixed(2)}s` }}
          />
          <circle className="trace-root" cx={t.from[0]} cy={t.from[1]} r={1.6} />
          <circle className="trace-node" cx={t.to[0]} cy={t.to[1]} r={2.4} />
        </g>
      ))}
    </svg>
  )
}

/**
 * The whole session's conversation, newest at the bottom. It follows new lines
 * down unless you have scrolled up to read something; JARVIS's lines decode
 * the way the HUD's do.
 */
function Conversation() {
  const turns = useStore((s) => s.turns)
  const shown = useStore((s) => s.ui.chrome.transcript)
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [turns])

  return (
    <div
      className="dash-convo-list"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {!shown || turns.length === 0 ? (
        <p className="dash-empty">{shown ? 'Nothing said yet.' : 'Transcript hidden.'}</p>
      ) : (
        turns.map((t) => (
          <div key={t.id} className={`log-line log-${t.role}`}>
            <span className="log-who">{t.role === 'user' ? 'YOU' : 'JARVIS'}</span>
            <span className="log-text">{t.role === 'jarvis' ? <DecodeText text={t.text} /> : t.text}</span>
          </div>
        ))
      )}
    </div>
  )
}

/**
 * One reading as an arc: three quarters of a circle, open at the bottom, lit
 * clockwise from the lower left. The number sits inside in text ink; the arc
 * only carries the proportion.
 */
function Ring({ value, label, reading }: { value: number; label: string; reading: string }) {
  const r = 26
  const sweep = 2 * Math.PI * r * 0.75
  const v = Math.min(1, Math.max(0, value))
  return (
    <figure className="dash-ring">
      <svg viewBox="0 0 64 64" aria-hidden>
        <circle className="dash-ring-track" cx="32" cy="32" r={r} strokeDasharray={`${sweep} 999`} transform="rotate(135 32 32)" />
        <circle
          className="dash-ring-fill"
          cx="32"
          cy="32"
          r={r}
          strokeDasharray={`${sweep * v} 999`}
          transform="rotate(135 32 32)"
        />
        <circle className="dash-ring-inner" cx="32" cy="32" r="19" />
      </svg>
      <b>{reading}</b>
      <figcaption>{label}</figcaption>
    </figure>
  )
}

/** The last minute of network traffic, down and up together, as a bar trace. */
function Traffic({ samples }: { samples: number[] }) {
  const peak = Math.max(1, ...samples)
  const pad = TRAFFIC_SAMPLES - samples.length
  return (
    <>
      <span className="dash-traffic-label">Data traffic · 1 min</span>
      <span className="dash-traffic-bars" aria-hidden>
        {Array.from({ length: TRAFFIC_SAMPLES }, (_, i) => (
          <i key={i} style={{ transform: `scaleY(${Math.max(0.04, (samples[i - pad] ?? 0) / peak)})` }} />
        ))}
      </span>
    </>
  )
}

type Personal = ReturnType<typeof useStore.getState>['personal']

function when(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 5)
  const today = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return time
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function Events({ personal }: { personal: Personal }) {
  if (!personal) return <p className="dash-empty">Reading your calendar…</p>
  if (personal.error && !personal.events.length) return <p className="dash-empty">{personal.error}</p>
  if (!personal.events.length) return <p className="dash-empty">Nothing coming up.</p>
  return (
    <ul className="dash-list">
      {personal.events.map((e, i) => (
        <li key={`${e.start}-${i}`} className="dash-event">
          <time>{when(e.start)}</time>
          <span>
            {e.title}
            {e.location && <small>{e.location}</small>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Inbox({ personal }: { personal: Personal }) {
  if (!personal) return <p className="dash-empty">Reading your inbox…</p>
  if (!personal.unread) return <p className="dash-empty">{personal.error ?? 'Inbox unavailable.'}</p>
  if (!personal.unread.latest.length) return <p className="dash-empty">Inbox zero.</p>
  return (
    <ul className="dash-list">
      {personal.unread.latest.map((m, i) => (
        <li key={`${m.at}-${i}`} className="dash-mail">
          <b>{m.from}</b>
          <span>{m.subject}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The live level as a waveform under the reactor. Drawn on its own animation
 * frame straight into the DOM: the level changes sixty times a second, and
 * routing it through React would re-render the whole dashboard at that rate.
 */
function VoiceMeter() {
  const bars = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    const history: number[] = Array(40).fill(0)
    const tick = () => {
      history.push(useStore.getState().level)
      history.shift()
      const el = bars.current
      if (el) {
        const kids = el.children
        for (let i = 0; i < kids.length; i++) {
          ;(kids[i] as HTMLElement).style.transform = `scaleY(${Math.max(0.05, history[i])})`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <span className="dash-voice" ref={bars} aria-hidden>
      {Array.from({ length: 40 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  )
}
