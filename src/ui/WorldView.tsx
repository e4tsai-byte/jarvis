import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'
import { GEV_URL } from '../config'
import { watchWorldTool } from '../lib/brain'

/**
 * God's Eye View, in JARVIS's own tab.
 *
 * Two layouts, and the page moves between them on its own:
 *
 *   'world'  — the globe fills the screen and JARVIS docks as an orb top-right,
 *              with the transcript in a card bottom-right.
 *   'jarvis' — JARVIS full screen as ever, the globe in a round scope
 *              bottom-right.
 *
 * Any world tool brings the world forward. It goes back to JARVIS once a minute
 * has passed with no world tools, no one touching the globe, and JARVIS idle.
 * W, the orb and the scope switch by hand.
 *
 * The iframe is mounted once and never moved in the DOM: switching is a
 * transform and a clip on the same element, so GEV keeps its camera, layers
 * and link across every switch instead of reloading.
 */

const IDLE_RETURN_MS = 60_000
const SCOPE_PX = 240
const SCOPE_MARGIN = 28
const ORB_RADIUS_PX = 70
const ORB_MARGIN = 22
/** The reactor's ring sits inside this share of the viewport height. */
const ORB_CLIP_VH = 0.3

type Layout = 'jarvis' | 'world'

/**
 * Where the two circles land, as CSS variables: the scope's scale and offset
 * for the globe, the orb's for the reactor. Pixel geometry lives here rather
 * than in the stylesheet because CSS cannot divide one length by another.
 */
function place() {
  const w = window.innerWidth
  const h = window.innerHeight
  const root = document.documentElement.style
  root.setProperty('--scope-scale', String(SCOPE_PX / h))
  root.setProperty('--scope-x', `${w - SCOPE_MARGIN - SCOPE_PX / 2 - w / 2}px`)
  root.setProperty('--scope-y', `${h - SCOPE_MARGIN - SCOPE_PX / 2 - h / 2}px`)
  root.setProperty('--orb-scale', String(ORB_RADIUS_PX / (ORB_CLIP_VH * h)))
  root.setProperty('--orb-x', `${w - ORB_MARGIN - ORB_RADIUS_PX - w / 2}px`)
  root.setProperty('--orb-y', `${ORB_MARGIN + ORB_RADIUS_PX - h / 2}px`)
}

export function WorldView() {
  const world = useStore((s) => s.world)
  const layout = useStore((s) => s.layout)
  const frame = useRef<HTMLIFrameElement>(null)
  const lastWorld = useRef(0)
  const lastActivity = useRef(0)

  const gevOrigin = useMemo(() => new URL(GEV_URL).origin, [])
  const src = useMemo(() => {
    const url = new URL(GEV_URL)
    url.searchParams.set('jarvis', '1')
    url.searchParams.set('welcome', '0')
    url.searchParams.set('embed', window.location.origin)
    return url.href
  }, [])

  const show = (next: Layout) => {
    lastWorld.current = Date.now()
    useStore.getState().setLayout(next)
  }

  useEffect(() => {
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [])

  // The stylesheet keys everything off one attribute on the root, and only
  // while this bridge has a world view at all.
  useEffect(() => {
    const root = document.documentElement
    if (world === null) delete root.dataset.layout
    else root.dataset.layout = layout
  }, [world, layout])
  useEffect(() => () => void delete document.documentElement.dataset.layout, [])

  // A world tool brings the world forward.
  useEffect(() => {
    watchWorldTool(() => {
      lastWorld.current = Date.now()
      const s = useStore.getState()
      if (s.world !== null && s.layout !== 'world') s.setLayout('world')
    })
  }, [])

  // ...and a quiet minute takes it back. While JARVIS is still working or
  // speaking the clock is held, so it counts from when he finishes.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useStore.getState()
      if (s.world === null || s.layout !== 'world') return
      const now = Date.now()
      if (s.phase === 'thinking' || s.phase === 'tooling' || s.phase === 'speaking') {
        lastWorld.current = now
        return
      }
      if (now - Math.max(lastWorld.current, lastActivity.current) > IDLE_RETURN_MS) {
        s.setLayout('jarvis')
      }
    }, 3000)
    return () => window.clearInterval(id)
  }, [])

  // What the embedded globe reports: activity, and the keys it would otherwise
  // keep for itself. Only from GEV's origin and only from this frame.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== gevOrigin || e.source !== frame.current?.contentWindow) return
      const m = e.data as { source?: string; type?: string; key?: string; code?: string }
      if (m?.source !== 'gev') return
      lastActivity.current = Date.now()
      // The release matters as much as the press: talking is hold-to-talk,
      // and a Space release that stayed inside the frame would leave the
      // microphone open.
      const up = m.type === 'keyup'
      if ((m.type === 'key' || up) && (m.key === ' ' || m.key === 'Enter' || m.key === 'w')) {
        window.dispatchEvent(
          new KeyboardEvent(up ? 'keyup' : 'keydown', {
            key: m.key,
            code: m.code ?? '',
            bubbles: true,
            cancelable: true,
          }),
        )
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [gevOrigin])

  // W switches by hand.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key !== 'w' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const s = useStore.getState()
      if (s.world === null || s.phase === 'offline' || s.phase === 'boot') return
      e.preventDefault()
      show(s.layout === 'world' ? 'jarvis' : 'world')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (world === null) return null

  return (
    <>
      <div className="world-frame">
        <iframe ref={frame} src={src} title="God's Eye View" />
      </div>
      <button
        type="button"
        className="world-scope-ring"
        onClick={() => show('world')}
        aria-label="Show the world view"
        tabIndex={layout === 'jarvis' ? 0 : -1}
      >
        <span>{world ? 'WORLD' : 'WORLD · OFFLINE'}</span>
      </button>
      <button
        type="button"
        className="world-orb-hit"
        onClick={() => show('jarvis')}
        aria-label="Full screen JARVIS"
        tabIndex={layout === 'world' ? 0 : -1}
      />
    </>
  )
}
