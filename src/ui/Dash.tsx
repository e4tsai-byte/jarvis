import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore, accentFor, type Conditions, type Vitals } from '../store'
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

/**
 * Where the user has dragged each readout, as an offset from its own place in
 * the layout. A per-browser convenience, so localStorage: a private window or
 * cleared site data simply starts from the default layout.
 */
type Offsets = Record<string, [number, number]>
const OFFSETS_KEY = 'jarvis.readouts'
const MOVE_HINT = 'Drag to move · double-click to put back'

function loadOffsets(): Offsets {
  try {
    const saved = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}')
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}
function saveOffsets(offsets: Offsets) {
  try {
    localStorage.setItem(OFFSETS_KEY, JSON.stringify(offsets))
  } catch {
    /* not remembered this time; the layout still moved */
  }
}
/** Tells the traces to re-route: a transform moves a readout without
 *  resizing anything, so no observer would notice. */
const relayout = (): void => {
  // Returns nothing on purpose: it is also an effect, and anything an effect
  // returns React will try to call as its cleanup.
  window.dispatchEvent(new Event('jarvis:readouts'))
}

/** An offset that keeps a readout, whose undragged box is `base`, on screen. */
function clampTo(base: DOMRect, x: number, y: number): [number, number] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return [
    Math.round(Math.min(vw - 4 - base.right, Math.max(4 - base.left, x))),
    Math.round(Math.min(vh - 4 - base.bottom, Math.max(4 - base.top, y))),
  ]
}

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
  const alerts = useStore((s) => s.alerts)
  const vitals = useStore((s) => s.vitals)
  const conditions = useStore((s) => s.conditions)
  const root = useRef<HTMLDivElement>(null)
  const [stats, setStats] = useState<Telemetry | null>(null)
  const [traffic, setTraffic] = useState<number[]>([])
  const [clock, setClock] = useState(() => new Date())
  const [engine, setEngine] = useState('')
  const offline = phase === 'offline'
  // The traces carry light while he is doing something.
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

  // Readouts the user has moved. While a drag is live the element is moved
  // directly, frame by frame; the state only takes the final position.
  const [offsets, setOffsets] = useState<Offsets>(loadOffsets)
  const drag = useRef<{ el: HTMLElement; name: string; x0: number; y0: number; ox: number; oy: number; base: DOMRect } | null>(
    null,
  )
  const place = (name: string) => {
    const o = offsets[name]
    return o ? { translate: `${o[0]}px ${o[1]}px` } : undefined
  }
  const commit = (update: (prev: Offsets) => Offsets) =>
    setOffsets((prev) => {
      const next = update(prev)
      saveOffsets(next)
      return next
    })

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // A button inside a readout is pressed, not dragged: capturing the pointer
    // here would take its click.
    if ((e.target as HTMLElement).closest('button, a')) return
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-drag]')
    const name = el?.dataset.anchor
    if (!el || !name) return
    const [ox, oy] = offsets[name] ?? [0, 0]
    const r = el.getBoundingClientRect()
    drag.current = { el, name, x0: e.clientX, y0: e.clientY, ox, oy, base: new DOMRect(r.left - ox, r.top - oy, r.width, r.height) }
    el.setPointerCapture(e.pointerId)
    el.classList.add('is-dragging')
    e.preventDefault()
  }
  const dragTo = (e: React.PointerEvent) => {
    const d = drag.current
    return d ? clampTo(d.base, d.ox + e.clientX - d.x0, d.oy + e.clientY - d.y0) : null
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const at = dragTo(e)
    if (!at || !drag.current) return
    drag.current.el.style.translate = `${at[0]}px ${at[1]}px`
    relayout()
  }
  // Two clicks on the same readout, without moving it, put it back where the
  // layout had it. Counted here rather than left to dblclick, which Chrome
  // does not send once pointerdown has been cancelled — as it is above.
  const lastTap = useRef<{ name: string; at: number } | null>(null)
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    const at = dragTo(e)
    if (!d || !at) return
    drag.current = null
    d.el.classList.remove('is-dragging')
    if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 4) {
      const now = performance.now()
      if (lastTap.current?.name === d.name && now - lastTap.current.at < 400) {
        lastTap.current = null
        commit((prev) => {
          const next = { ...prev }
          delete next[d.name]
          return next
        })
      } else {
        lastTap.current = { name: d.name, at: now }
      }
      return
    }
    lastTap.current = null
    commit((prev) => ({ ...prev, [d.name]: at }))
  }

  // Once React has placed them, the traces follow.
  useEffect(relayout, [offsets])

  // A smaller window must not strand a readout off screen.
  useEffect(() => {
    const fit = () =>
      setOffsets((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [name, [x, y]] of Object.entries(prev)) {
          const el = root.current?.querySelector<HTMLElement>(`[data-drag][data-anchor="${name}"]`)
          if (!el) continue
          const r = el.getBoundingClientRect()
          const [cx, cy] = clampTo(new DOMRect(r.left - x, r.top - y, r.width, r.height), x, y)
          if (cx !== x || cy !== y) {
            next[name] = [cx, cy]
            changed = true
          }
        }
        if (!changed) return prev
        saveOffsets(next)
        return next
      })
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

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

  // Whatever the bridge already knows about the calendar and inbox, your
  // vitals and the conditions at home; later reads arrive over the socket.
  useEffect(() => {
    if (offline) return
    const s = useStore.getState()
    const read = <T,>(path: string, use: (data: T) => void) =>
      fetch(`${BRIDGE_HTTP_URL}${path}`, { signal: AbortSignal.timeout(3000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ data?: T } | null>) : null))
        .then((p) => p?.data && use(p.data))
        .catch(() => {})
    read('/dash/personal', s.setPersonal)
    read('/dash/vitals', s.setVitals)
    read('/dash/conditions', s.setConditions)
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
        {alerts && (
          <span
            className={`dash-chip${alerts.enabled && !alerts.quiet ? ' on' : ''}`}
            title="Whether JARVIS speaks up unprompted. Ask him to change it."
          >
            ALERTS · {!alerts.enabled ? 'OFF' : alerts.quiet ? 'QUIET' : 'ON'}
          </span>
        )}
        <time className="dash-clock">
          {clock.toLocaleDateString([], { month: 'short', day: 'numeric' })}
          {' · '}
          {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </header>

      <section
        className="dash-jarvis"
        data-slot="jarvis"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <Traces />

        <div className="dash-row-top">
          <div data-anchor="cpu" data-drag style={place('cpu')} title={MOVE_HINT}>
            <Ring value={(stats?.cpu ?? 0) / 100} label="CPU" reading={stats ? `${stats.cpu}%` : '—'} />
          </div>
          <div className="dash-traffic" data-anchor="traffic" data-drag style={place('traffic')} title={MOVE_HINT}>
            <Traffic samples={traffic} />
          </div>
          <div data-anchor="mem" data-drag style={place('mem')} title={MOVE_HINT}>
            <Ring value={memPct / 100} label="Memory" reading={stats ? `${memPct}%` : '—'} />
          </div>
        </div>

        <aside className="dash-flank dash-flank-left">
          <section className="dash-block" data-anchor="today" data-drag style={place('today')} title={MOVE_HINT}>
            <h3 className="dash-title">Today</h3>
            <Events personal={personal} />
          </section>
          <section className="dash-block" data-anchor="inbox" data-drag style={place('inbox')} title={MOVE_HINT}>
            <h3 className="dash-title">Inbox{personal?.unread ? ` · ${personal.unread.count} unread` : ''}</h3>
            <Inbox personal={personal} />
          </section>
          <section className="dash-block" data-anchor="vitals" data-drag style={place('vitals')} title={MOVE_HINT}>
            <h3 className="dash-title">Vitals</h3>
            <VitalsReadout vitals={vitals} />
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
          <section className="dash-block" data-anchor="threat" data-drag style={place('threat')} title={MOVE_HINT}>
            <h3 className="dash-title">Threat level</h3>
            <Threat conditions={conditions} linked={world === true} />
          </section>
          <section className="dash-block" data-anchor="weather" data-drag style={place('weather')} title={MOVE_HINT}>
            <h3 className="dash-title">Weather{conditions?.home ? ` · ${conditions.home.name.split(',')[0]}` : ''}</h3>
            <Weather conditions={conditions} />
          </section>
          <section className="dash-block" data-anchor="machine" data-drag style={place('machine')} title={MOVE_HINT}>
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
          <section className="dash-block" data-anchor="link" data-drag style={place('link')} title={MOVE_HINT}>
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
            {Object.keys(offsets).length > 0 && (
              <button type="button" className="dash-reset" onClick={() => commit(() => ({}))}>
                Reset readouts
              </button>
            )}
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
        // A readout a short window has hidden has no box, and gets no trace.
        return r && r.width + r.height > 0 && {
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

      // Each run lands on whichever side of its readout faces the orb, so a
      // readout dragged anywhere is still met head-on rather than looped
      // around. Beside the orb, that is the near edge at the title line —
      // where a group's own hairline starts — and the run leaves about 20°
      // above or below level, so it sweeps in rather than lying flat. Above
      // or below the orb, it is the near edge's middle.
      const toward = (name: string) => {
        const a = at(name)
        if (!a) return
        const ax = (a.l + a.r) / 2
        const ay = (a.t + a.b) / 2
        const dx = ax - cx
        const dy = ay - cy
        if (Math.abs(dx) * 0.8 > Math.abs(dy)) {
          const left = dx < 0
          const titled = Boolean(el.querySelector(`[data-anchor="${name}"] .dash-title`))
          const ty = titled ? a.t + 5 : ay
          flow(left ? a.r + 4 : a.l - 8, ty, [left ? -1 : 1, 0], 0.35 * Math.sign(ty - cy) * (left ? -1 : 1))
        } else {
          const above = dy < 0
          flow(ax, above ? a.b + 6 : a.t - 6, [0, above ? -1 : 1])
        }
      }
      for (const name of ['cpu', 'traffic', 'mem', 'today', 'inbox', 'vitals', 'threat', 'weather', 'machine', 'link']) {
        toward(name)
      }

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
    // A dragged readout moves by transform, which no observer sees.
    window.addEventListener('jarvis:readouts', draw)
    return () => {
      ro.disconnect()
      window.removeEventListener('jarvis:readouts', draw)
    }
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
          <div key={t.id} className={`log-line log-${t.role}${t.tag ? ' log-tagged' : ''}`}>
            <span className="log-who">{t.role === 'user' ? 'YOU' : t.tag ? t.tag.toUpperCase() : 'JARVIS'}</span>
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

/** °F, mph and miles where the browser's locale is American; °C, km/h and km
 *  everywhere else. The bridge sends metric. */
const IMPERIAL = (() => {
  try {
    return new Intl.Locale(navigator.language).maximize().region === 'US'
  } catch {
    return false
  }
})()
const deg = (c: number | null | undefined) => (c == null ? '—' : `${Math.round(IMPERIAL ? (c * 9) / 5 + 32 : c)}°`)
const speed = (kmh: number) => (IMPERIAL ? `${Math.round(kmh / 1.609)} mph` : `${Math.round(kmh)} km/h`)
const distance = (km: number, places = 0) =>
  IMPERIAL ? `${(km / 1.609).toFixed(places)} mi` : `${km.toFixed(places)} km`
const hm = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, '0')}m`

/** "today", "yesterday", "3d ago" — by calendar day, not by hours. */
function ago(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`
}

/** One activity, for the Last row's tooltip. */
const activityLine = (a: Vitals['recent'][number]) =>
  `${when(a.start)}  ${a.name}` +
  [a.km ? distance(a.km, 1) : null, a.minutes ? `${a.minutes} min` : null, a.effort != null ? `effort ${a.effort}` : null]
    .filter(Boolean)
    .map((s) => ` · ${s}`)
    .join('')

/**
 * HRV and sleep against their usual, the week's training load, and the latest
 * two activities. A value a source could not give says why, in words, where
 * the number would be.
 */
function VitalsReadout({ vitals }: { vitals: Vitals | null }) {
  if (!vitals) return <p className="dash-empty">Reading your vitals…</p>
  const { hrv, sleep, load, notes, recent } = vitals
  const last = recent[0]
  if (vitals.error && !hrv && !sleep && !load && !vitals.recent.length) {
    return <p className="dash-empty">{vitals.error}</p>
  }
  const missing = (note: string | null, source: string) => (
    <span className="dash-na" title={`From ${source}${note ? ` — ${note}` : ''}`}>
      {note ?? '—'}
    </span>
  )
  return (
    <>
      <dl className="dash-readout">
        <div>
          <dt>HRV</dt>
          <dd title={hrv ? `Overnight RMSSD, ${hrv.date}` : undefined}>
            {hrv ? (
              <>
                {hrv.value} ms{hrv.baseline ? <small> · usual {hrv.baseline}</small> : null}
              </>
            ) : (
              missing(notes.hrv, 'Tredict')
            )}
          </dd>
        </div>
        <div>
          <dt>Sleep</dt>
          <dd title={sleep ? `Night of ${sleep.date}` : undefined}>
            {sleep ? (
              <>
                {hm(sleep.minutes)}
                {sleep.baselineMinutes ? <small> · usual {hm(sleep.baselineMinutes)}</small> : null}
              </>
            ) : (
              missing(notes.sleep, 'Tredict')
            )}
          </dd>
        </div>
        <div>
          <dt>Load 7d</dt>
          <dd
            title={
              load
                ? `Strava relative effort: ${load.week} over ${load.sessions} sessions in 7 days; a usual week is ${load.typical}`
                : undefined
            }
          >
            {load ? (
              <>
                {load.week}
                {load.ratio != null ? <small> · {load.ratio.toFixed(1)}× usual</small> : null}
              </>
            ) : (
              missing(notes.activities ?? 'no effort data', 'Strava')
            )}
          </dd>
        </div>
        <div>
          <dt>Last</dt>
          <dd title={recent.map(activityLine).join('\n') || undefined}>
            {last ? (
              <>
                {last.name}
                <small> · {ago(last.start)}</small>
              </>
            ) : (
              missing(notes.activities, 'Strava')
            )}
          </dd>
        </div>
      </dl>
    </>
  )
}

const THREAT_CLASS = ['calm', 'guarded', 'elevated', 'alert']

type Reason = NonNullable<Conditions['threat']>['reasons'][number]

/** Camera range, in metres, that frames each kind of hazard. */
const FRAME_M: Record<string, number> = { storm: 2_500_000, quake: 600_000, wildfire: 120_000, hotspots: 150_000 }

/** Bring the globe forward and fly it to a hazard. The layout switches at
 *  once, so the flight is watched rather than waited for. */
function showOnGlobe(r: Reason) {
  const s = useStore.getState()
  s.setLayout('world')
  fetch(`${BRIDGE_HTTP_URL}/dash/world/fly`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lat: r.lat, lon: r.lon, rangeM: FRAME_M[r.kind] ?? 250_000 }),
    signal: AbortSignal.timeout(50_000),
  })
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status))
    })
    .catch(() => s.setError('The globe could not be moved there.'))
}

/** Calm to alert, as a word and four segments, with what is behind it. */
function Threat({ conditions, linked }: { conditions: Conditions | null; linked: boolean }) {
  if (!conditions) return <p className="dash-empty">Assessing…</p>
  if (!conditions.home) return <p className="dash-empty">Tell me where home is: “My home is Taipei.”</p>
  const t = conditions.threat
  if (!t) return <p className="dash-empty">{conditions.error ?? 'Assessing…'}</p>
  const about =
    `Earthquakes, fires, storms, weather warnings and air near ${conditions.home.name}.\n` +
    t.reasons.map((r) => `${r.text}${r.km != null ? ` · ${distance(r.km)}` : ''}\n`).join('') +
    `Sources: ${t.sources.join(', ')}` +
    (t.missing.length ? `\nNot read this time: ${t.missing.join(', ')}` : '') +
    (linked && t.reasons.length ? '\nClick a line to see it on the globe.' : '')
  return (
    <div className={`dash-threat is-${THREAT_CLASS[t.level]}`} title={about}>
      <div className="dash-threat-head">
        <b>{t.label}</b>
        <span className="dash-threat-meter" aria-hidden>
          {THREAT_CLASS.map((c, i) => (
            <i key={c} className={i <= t.level ? 'on' : undefined} />
          ))}
        </span>
      </div>
      <ul className="dash-threat-why">
        {t.reasons.length === 0 ? (
          <li>Nothing nearby{t.missing.length ? ' (partial read)' : ''}</li>
        ) : (
          // Two lines at most; the tooltip lists them all.
          t.reasons.slice(0, 2).map((r) => (
            <li key={r.text}>
              {linked && r.lat != null && r.lon != null ? (
                <button type="button" className="dash-threat-go" title="Show it on the globe" onClick={() => showOnGlobe(r)}>
                  {r.text}
                  {r.km != null && <small> · {distance(r.km)}</small>}
                </button>
              ) : (
                <>
                  {r.text}
                  {r.km != null && <small> · {distance(r.km)}</small>}
                </>
              )}
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

/** Now, today's range, the wind and the air. */
function Weather({ conditions }: { conditions: Conditions | null }) {
  const w = conditions?.weather
  if (!w) {
    return (
      <p className="dash-empty">
        {!conditions ? 'Reading the weather…' : !conditions.home ? 'No home set.' : (conditions.error ?? 'Weather unavailable.')}
      </p>
    )
  }
  const air = conditions.air
  return (
    <>
      <div className="dash-wx-now">
        <b>{deg(w.temp)}</b>
        <span>
          {w.condition}
          <small>
            feels {deg(w.feels)} · {Math.round(w.humidity)}%
          </small>
        </span>
      </div>
      <dl className="dash-readout">
        <div>
          <dt>Hi · Lo</dt>
          <dd>
            {deg(w.high)} · {deg(w.low)}
          </dd>
        </div>
        <div>
          <dt>Wind</dt>
          <dd title={`Gusts ${speed(w.gusts)}`}>{speed(w.wind)}</dd>
        </div>
        <div>
          <dt>Air</dt>
          <dd title={air ? `US AQI ${air.aqi}${air.pm25 != null ? `, PM2.5 ${air.pm25} µg/m³` : ''}` : undefined}>
            {air ? (
              <>
                {air.aqi}
                <small> · {air.category}</small>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>
      <span className="dash-source">Weather data by Open-Meteo.com</span>
    </>
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
