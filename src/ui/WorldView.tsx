import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'
import { GEV_URL } from '../config'
import { watchWorldTool } from '../lib/brain'

/**
 * God's Eye View, in JARVIS's own tab.
 *
 * Two layouts, and the page moves between them on its own:
 *
 *   'dash'  — the dashboard: the globe live and interactive in its panel.
 *   'world' — the globe fills the screen and JARVIS docks as an orb top-right,
 *             with the transcript in a card bottom-right.
 *
 * Any world tool brings the world forward. It goes back to the dashboard once a
 * minute has passed with no world tools, no one touching the globe, no layout
 * switch, and JARVIS idle. W, the expand button and the orb switch by hand.
 *
 * The iframe is mounted once and never moved in the DOM: switching is a
 * transform and a crop on the same element (see Dash's measure and index.css),
 * so GEV keeps its camera, layers and link across every switch.
 */

const IDLE_RETURN_MS = 60_000

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

  // Where the orb docks is measured by the dash (Dash.tsx), since it starts
  // from the reactor's spot in its panel.

  // The stylesheet keys everything off two attributes on the root.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.layout = layout
    root.dataset.world = world ? 'on' : 'off'
  }, [world, layout])
  useEffect(
    () => () => {
      delete document.documentElement.dataset.layout
      delete document.documentElement.dataset.world
    },
    [],
  )

  // Tell the globe which view it is in: the bare globe in a panel, or GEV's
  // full interface on the whole screen.
  // The full-screen hub counts as the dash here: the globe is out of sight in
  // its panel either way, and should be the bare globe when it comes back.
  const tellGlobe = () =>
    frame.current?.contentWindow?.postMessage(
      { source: 'jarvis', type: 'layout', layout: layout === 'world' ? 'world' : 'dash' },
      gevOrigin,
    )
  useEffect(tellGlobe, [layout, world, gevOrigin])

  // A world tool brings the world forward.
  useEffect(() => {
    watchWorldTool(() => {
      lastWorld.current = Date.now()
      const s = useStore.getState()
      if (s.world && s.layout !== 'world') s.setLayout('world')
    })
  }, [])

  // ...and a quiet minute takes it back. While JARVIS is still working or
  // speaking the clock is held, so it counts from when he finishes.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useStore.getState()
      if (s.layout !== 'world') return
      const now = Date.now()
      if (s.phase === 'thinking' || s.phase === 'tooling' || s.phase === 'speaking') {
        lastWorld.current = now
        return
      }
      if (now - Math.max(lastWorld.current, lastActivity.current, s.layoutAt) > IDLE_RETURN_MS) {
        s.setLayout(s.layoutBack)
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
      // The globe is listening now: whatever layout was sent before this may
      // have landed before its listener existed, so send it again. Not
      // activity — nobody touched anything.
      if (m.type === 'ready') {
        frame.current?.contentWindow?.postMessage(
          { source: 'jarvis', type: 'layout', layout: useStore.getState().layout === 'world' ? 'world' : 'dash' },
          gevOrigin,
        )
        return
      }
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
      if (!s.world || s.phase === 'offline' || s.phase === 'boot') return
      e.preventDefault()
      s.setLayout(s.layout === 'world' ? s.layoutBack : 'world')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (world === null) return null

  return (
    <>
      <div className="world-frame">
        <iframe ref={frame} src={src} title="God's Eye View" onLoad={tellGlobe} />
      </div>
      <button
        type="button"
        className="world-orb-hit"
        onClick={() => useStore.getState().setLayout('dash')}
        aria-label="Back to the dashboard"
        tabIndex={layout === 'dash' ? -1 : 0}
      />
    </>
  )
}
