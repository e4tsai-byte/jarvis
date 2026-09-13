import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * JARVIS's view of the world.
 *
 * God's Eye View (GEV) is a live 3D globe — real aircraft, ships, satellites,
 * earthquakes, fires, public cameras — that ships its own voice agent with 28
 * tools. This module lets Claude hold those tools instead. GEV runs in its own
 * window with `?jarvis=1`; its link connects to this bridge on /world, and each
 * call on this server is forwarded to it and answered by the same runner GEV's
 * own agent uses.
 *
 * The schemas are read from the GEV checkout rather than copied, so a tool GEV
 * changes next week changes here too. What JARVIS adds is `world_look`: the
 * frame itself, so it can see what it is talking about.
 *
 * The /world socket is an executor, never a user. It can answer requests made
 * from here and nothing else — it has no way to start a turn.
 */

export const GEV_DIR = process.env.GEV_DIR ?? join(homedir(), 'Github', 'gods-eye-view')

/** GEV's dev server. Only these origins may hold the world link. */
const GEV_ORIGINS = new Set(
  (process.env.GEV_ORIGIN ?? 'http://localhost:4173,http://127.0.0.1:4173')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)

export const worldOriginAllowed = (origin) =>
  Boolean(origin) && GEV_ORIGINS.has(origin.replace(/\/+$/, ''))

/**
 * Loaded on every turn. The rest (22 of 28) wait behind tool search: all of
 * them up front is ~6.5k tokens on every turn, including the ones about the
 * weather in the kitchen.
 */
const CORE_TOOLS = new Set([
  'get_current_view_state',
  'get_entity_context',
  'fly_to_location',
  'set_layer_visibility',
  'analyst_query',
])

/** Camera flights with waitForArrival genuinely take this long. */
const RUN_TIMEOUT_MS = 45_000
const LOOK_TIMEOUT_MS = 20_000
/** GEV's results are written for a short-context voice model; this is slack. */
const MAX_RESULT_CHARS = 20_000

const NOT_OPEN =
  'The world view is not open. Tell the user once, in one sentence, to open ' +
  "God's Eye View at http://localhost:4173/?jarvis=1&welcome=0 beside this window."

const HIDDEN =
  'The world view window is hidden or minimised, so there is no current frame. ' +
  'Say you cannot see it right now. Do not describe an earlier view as current.'

const INSTRUCTIONS = `God's Eye View: a live 3D globe in the user's second window — real aircraft, ships, satellites, earthquakes, fires, public cameras and radio. These tools steer it and read it; world_look shows you the frame itself.

- Seeing: for "what am I looking at", "what's here", "read that sign", call world_look. It returns the current frame plus structured scene context. Name places from the context; read only labels that are clearly legible in the image. If it reports the window hidden, say you cannot see it right now.
- Moving: "take me to X" is fly_to_location (omit rangeM unless a height is asked for). Relative zoom is adjust_camera_zoom; "globe view" or "whole earth" is zoom_to_globe. Orbit, pan, tilt and stop are move_camera; a bare "stop" while the camera moves means move_camera stop.
- Layers, basemaps and styles are different things. "Satellites" always means the satellites data layer (set_layer_visibility), never a basemap. A basemap change needs a stack name (set_map_stack). Night vision, thermal and CRT are styles (set_visual_style).
- Questions about the data — how many flights over Texas, the biggest fire near Los Angeles, anything above forty thousand feet — are analyst_query. Every count names its scope ("42 in view", "about 30 within 250 km of Austin"), is stated exactly as returned, and covers loaded data only.
- Following something is track_entity (analyst_query first for "the nearest one"). While Cockpit is active, track_entity and fly_to_location are refused by design: use control_cockpit, or exit Cockpit first.
- When you explain specific places, mark them with annotate_map: type=area for buildings and districts, arrow for "how far", route for walking or driving. Prefer names; never invent coordinates. Marks persist; clear them only when asked.
- Confirm only what came back ok=true, and echo the resulting state ("Tracking UAL428"). On ok=false say what failed in one sentence. partial and outlinePending are not full success.
- People are not a query type. Never identify, describe, or follow individual people in camera feeds or street imagery, and never combine the world view with the user's own camera.`

const LOOK_DESCRIPTION = `Look at the God's Eye View globe on the user's screen.

Returns the current frame as an image you can actually see, plus structured context: where the camera is, the place and street labels around it, the view scale, and what is selected or in view.

Use it when the answer is in the view — "what am I looking at", "what's that building", "read that sign", "describe this", "what does it look like from here". For counts and data questions use analyst_query instead; for where the camera is, get_current_view_state is cheaper.

One look per question. After the camera moves, look again rather than reasoning from the old frame.`

/**
 * Tool schemas from the GEV checkout, converted once at startup. A schema that
 * will not convert is skipped and logged, so one odd tool in a future GEV
 * cannot take the whole world view down with it. Null when GEV is not there.
 */
export async function loadWorldTools(dir = GEV_DIR) {
  const file = join(dir, 'server', 'providers', 'openai', 'tools.js')
  if (!existsSync(file)) return null
  let defs
  try {
    ;({ GEV_REALTIME_TOOLS: defs } = await import(pathToFileURL(file).href))
  } catch (err) {
    console.warn(`[jarvis] world view tools could not be read: ${err?.message ?? err}`)
    return null
  }
  const tools = []
  for (const def of defs ?? []) {
    try {
      const { shape } = z.fromJSONSchema(def.parameters ?? { type: 'object' })
      tools.push({ name: def.name, description: def.description, shape: shape ?? {} })
    } catch (err) {
      console.warn(`[jarvis] world tool ${def?.name} skipped: ${err?.message ?? err}`)
    }
  }
  return tools
}

/**
 * The one GEV page JARVIS is looking through. Process-wide rather than per
 * conversation: there is one globe on the screen, whichever turn is asking.
 * A newer page replaces an older one, so a reload does not leave JARVIS
 * talking to a tab that no longer exists.
 */
export function createWorldLink() {
  let socket = null
  let seq = 0
  const waiting = new Map()

  return {
    get connected() {
      return Boolean(socket) && socket.readyState === socket.OPEN
    },

    attach(ws) {
      if (socket && socket !== ws) {
        try {
          socket.close(4000, 'replaced by a newer world view')
        } catch {
          /* already gone */
        }
      }
      socket = ws

      ws.on('message', (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (msg?.type === 'hello') {
          console.log(`[jarvis] world view linked (${String(msg.app ?? 'unknown').slice(0, 40)})`)
          return
        }
        if ((msg?.type === 'result' || msg?.type === 'look') && typeof msg.id === 'string') {
          waiting.get(msg.id)?.resolve(msg)
        }
      })

      ws.on('close', () => {
        if (socket === ws) {
          socket = null
          console.log('[jarvis] world view unlinked')
        }
        for (const slot of [...waiting.values()]) {
          if (slot.ws === ws) slot.reject(new Error('the world view was closed'))
        }
      })
    },

    /** Correlated by id, timed out, and cancelled if the turn is abandoned. */
    request(type, payload, { timeoutMs = RUN_TIMEOUT_MS, signal } = {}) {
      return new Promise((resolve, reject) => {
        const ws = socket
        if (!ws || ws.readyState !== ws.OPEN) return reject(new Error('not open'))
        const id = `w${++seq}`

        const settle = (fn, value) => {
          const slot = waiting.get(id)
          if (!slot) return
          waiting.delete(id)
          clearTimeout(slot.timer)
          signal?.removeEventListener('abort', onAbort)
          fn(value)
        }
        const onAbort = () => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'cancel', id }))
          settle(reject, new Error('cancelled'))
        }

        waiting.set(id, {
          ws,
          resolve: (v) => settle(resolve, v),
          reject: (e) => settle(reject, e),
          timer: setTimeout(
            () => settle(reject, new Error('it did not answer in time')),
            timeoutMs,
          ),
        })
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        ws.send(JSON.stringify({ type, id, ...payload }))
      })
    },
  }
}

const text = (t) => ({ type: 'text', text: t })
const failed = (t) => ({ isError: true, content: [text(t)] })
const clip = (s) =>
  s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}… [truncated]` : s

/**
 * @param {ReturnType<typeof createWorldLink>} link
 * @param {Awaited<ReturnType<typeof loadWorldTools>>} tools
 */
export function worldServer(link, tools) {
  // GEV's results are already written for a model to read — {ok, …state},
  // with static error text so a place name cannot carry instructions — so
  // they pass through as they are. Only a failure to reach GEV is an error.
  const run = async (name, args, extra) => {
    if (!link.connected) return failed(NOT_OPEN)
    let reply
    try {
      reply = await link.request('run', { name, args }, { signal: extra?.signal })
    } catch (err) {
      return failed(`The world view did not complete ${name}: ${err?.message ?? err}.`)
    }
    const result = reply.result ?? { ok: false, action: name, error: 'No result came back.' }
    return { content: [text(clip(JSON.stringify(result)))] }
  }

  const look = async (_args, extra) => {
    if (!link.connected) return failed(NOT_OPEN)
    let reply
    try {
      reply = await link.request('look', {}, { timeoutMs: LOOK_TIMEOUT_MS, signal: extra?.signal })
    } catch (err) {
      return failed(`Could not look at the world view: ${err?.message ?? err}.`)
    }
    const content = []
    if (typeof reply.image === 'string' && reply.image) {
      content.push(
        text(
          "The God's Eye View frame on the user's screen right now. Read only " +
            'labels that are clearly legible, and combine them with the scene ' +
            'context that follows.',
        ),
        { type: 'image', data: reply.image, mimeType: reply.mimeType ?? 'image/jpeg' },
      )
    } else {
      content.push(
        text(
          reply.hidden
            ? HIDDEN
            : 'No fresh frame could be captured. Say you cannot see the view clearly right now; do not guess.',
        ),
      )
    }
    if (reply.context) content.push(text(`Scene context: ${clip(JSON.stringify(reply.context))}`))
    return { content }
  }

  return createSdkMcpServer({
    name: 'jarvis_world',
    version: '1.0.0',
    instructions: INSTRUCTIONS,
    tools: [
      tool('world_look', LOOK_DESCRIPTION, {}, look, { alwaysLoad: true }),
      ...tools.map((t) =>
        tool(t.name, t.description, t.shape, (args, extra) => run(t.name, args, extra), {
          alwaysLoad: CORE_TOOLS.has(t.name),
        }),
      ),
    ],
  })
}
