import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'

/**
 * The dash's Now playing tile, on demand.
 *
 * Spotify's connector asks that its now-playing tool be called only when the
 * user asks what is playing, never of its own accord — so nothing here polls.
 * The tile is read when the user clicks it, by a small read-only Haiku run
 * like the vitals; and whenever JARVIS is asked "what's playing?", his own
 * answer is kept for the tile at no extra cost (server.mjs hands it over).
 */

export const NOW_PLAYING = 'mcp__claude_ai_Spotify__get_currently_playing'
/** Clicks closer together than this share one read. */
const MIN_GAP_MS = 10_000

const IDLE = {
  playing: false,
  title: '',
  artist: '',
  album: '',
  art: null,
  progressMs: null,
  durationMs: null,
  url: null,
}
const EMPTY = { at: 0, error: null, reading: false, source: null, ...IDLE }

/** A tool result's text, whichever shape its content came in. */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (c?.type === 'text' ? c.text : '')).join('\n')
}

const text = (v, n) => String(v ?? '').trim().slice(0, n)
const https = (v) => (typeof v === 'string' && /^https:\/\//.test(v) ? v : null)
const ms = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null)

/** The smallest cover still big enough for the tile, from Spotify's list. */
function cover(images) {
  const list = (Array.isArray(images) ? images : []).filter((i) => https(i?.url))
  if (!list.length) return null
  const fit = list.filter((i) => !i.width || i.width >= 64).sort((a, b) => (a.width ?? 999) - (b.width ?? 999))[0]
  return (fit ?? list[0]).url
}

function flatten(node, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flatten(v, key, out, depth + 1)
    else out[key] = v
  }
  return out
}

/**
 * Who it is by, found anywhere in the answer: the artists of a track, or the
 * show, publisher or author of an episode. A list of names or of {name}s.
 */
function byline(v) {
  const flat = flatten(v)
  const names = (x) =>
    Array.isArray(x) ? x.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(', ') : typeof x === 'string' ? x : ''
  for (const want of [/artist/i, /show.?name|(^|\.)show$/i, /publisher|author|creator/i]) {
    for (const [k, x] of Object.entries(flat)) {
      if (want.test(k) && !/id$|uri$|url$|href$/i.test(k) && names(x)) return names(x)
    }
  }
  return ''
}

/**
 * What the tool says is playing, reduced to what the tile shows, or null for
 * an answer it cannot read. When this was written the tool had only ever
 * answered {} — nothing playing — so it reads Spotify's own Web API layout
 * (item.name, item.artists, album.images, progress_ms) and, failing that,
 * finds the same fields by name.
 */
export function parseNowPlaying(raw) {
  let v
  try {
    v = JSON.parse(raw)
  } catch {
    return /no (active|current)|nothing (is )?playing|not playing/i.test(raw) ? { ...IDLE } : null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null

  const item = v.item && typeof v.item === 'object' ? v.item : null
  if (item?.name) {
    return {
      playing: v.is_playing !== false,
      title: text(item.name, 120),
      artist: text(
        (Array.isArray(item.artists) ? item.artists : []).map((a) => a?.name).filter(Boolean).join(', ') ||
          item.show?.name ||
          byline(v),
        120,
      ),
      album: text(item.album?.name ?? item.show?.name, 120),
      art: cover(item.album?.images ?? item.images ?? item.show?.images),
      progressMs: ms(v.progress_ms),
      durationMs: ms(item.duration_ms),
      url: https(item.external_urls?.spotify),
    }
  }

  // Not the Web API's layout: the same fields, found by name.
  const flat = flatten(v)
  const find = (want, not = /$^/) => Object.entries(flat).find(([k, x]) => want.test(k) && !not.test(k) && x != null && x !== '')
  const title = find(/(^|\.)(track.?name|song|title|name)$/i, /artist|album|device|playlist|context|show/i)?.[1]
  if (typeof title !== 'string' || !title.trim()) {
    // {} or a bare "not playing": nothing on.
    return Object.keys(flat).length === 0 || find(/playing/i)?.[1] === false ? { ...IDLE } : null
  }
  const artist = byline(v)
  const time = (hit) => {
    if (!hit) return null
    const [k, x] = hit
    return /sec/i.test(k) && !/ms/i.test(k) ? ms(Number(x) * 1000) : ms(x)
  }
  const art = Object.entries(flat).find(([k, x]) => /image|art|cover|thumbnail/i.test(k) && https(x))?.[1]
  const images = Object.entries(flat).find(([k, x]) => /images/i.test(k) && Array.isArray(x))?.[1]
  const playing = find(/is.?playing|(^|\.)playing$/i)?.[1]
  return {
    playing: playing !== false,
    title: text(title, 120),
    artist: text(artist, 120),
    album: text(find(/album.?name|(^|\.)album$/i)?.[1], 120),
    art: art ?? cover(images),
    progressMs: time(find(/progress/i)),
    durationMs: time(find(/duration|length/i)),
    url: https(Object.entries(flat).find(([, x]) => typeof x === 'string' && /^https:\/\/open\.spotify\.com\//.test(x))?.[1]),
  }
}

/** The one-off read may call the now-playing tool and nothing else. */
async function canUseTool(name, input) {
  return name === 'ToolSearch' || name === NOW_PLAYING
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: 'Read-only: the now-playing tool only.' }
}

export function createNowPlaying() {
  let data = null
  let reading = null
  let lastRead = 0
  const listeners = new Set()
  const publish = (next) => {
    data = next
    for (const fn of listeners) fn(data)
  }

  /** Keep a tool result as the tile's track. False when it cannot be read. */
  const take = (content, source) => {
    const raw = resultText(content)
    const track = parseNowPlaying(raw)
    if (!track) return false
    // The playing answer's layout has not been seen whole yet. When it names
    // no artist, log its field names — never their values — so the next read
    // says where the artist is.
    if (track.title && !track.artist) {
      try {
        console.log(`[jarvis] now playing: no artist found; the answer's fields are ${Object.keys(flatten(JSON.parse(raw))).join(', ')}`)
      } catch {
        /* not JSON: nothing to list */
      }
    }
    publish({ at: Date.now(), error: null, reading: false, source, ...track })
    return true
  }

  /** Read Spotify now, for the tile's own click. Resolves to what is shown. */
  const read = () => {
    if (reading) return reading
    // Measured from when the last read finished: a read itself can take
    // longer than the gap.
    if (data?.at && !data.error && Date.now() - lastRead < MIN_GAP_MS) return Promise.resolve(data)
    publish({ ...(data ?? EMPTY), reading: true, error: null })
    reading = (async () => {
      try {
        const session = query({
          prompt:
            `The user asked what is playing on Spotify. Call ${NOW_PLAYING} once. If it is not available yet, ` +
            'load it with ToolSearch first: it may still be connecting. Then reply with the one word: done.',
          options: {
            model: 'haiku',
            settingSources: [],
            maxTurns: 4,
            cwd: homedir(),
            systemPrompt: 'You read what is playing on Spotify with one read-only tool, and never summarise it.',
            canUseTool,
          },
        })
        let call = null
        let got = null
        for await (const m of session) {
          if (m.type === 'assistant') {
            for (const b of m.message?.content ?? []) if (b.type === 'tool_use' && b.name === NOW_PLAYING) call = b.id
          } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
            for (const b of m.message.content) if (b?.type === 'tool_result' && b.tool_use_id === call) got = b
          } else if (m.type === 'result') {
            break
          }
        }
        if (!got) throw Object.assign(new Error('no answer from the tool'), { said: "Spotify isn't connected." })
        if (got.is_error) {
          throw Object.assign(new Error(resultText(got.content).slice(0, 160)), { said: 'Spotify could not be read.' })
        }
        if (!take(got.content, 'tile')) {
          throw Object.assign(new Error(`unreadable answer: ${resultText(got.content).slice(0, 160)}`), {
            said: "Spotify's answer could not be read.",
          })
        }
        console.log(`[jarvis] now playing read (${data.title ? `${data.title} — ${data.artist}` : 'nothing playing'})`)
      } catch (err) {
        console.warn(`[jarvis] now playing: ${err?.message ?? err}`)
        publish({ ...(data ?? EMPTY), at: Date.now(), reading: false, error: err?.said ?? 'Spotify could not be read.' })
      } finally {
        reading = null
        lastRead = Date.now()
      }
      return data
    })()
    return reading
  }

  return {
    get: () => data,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    read,
    take,
  }
}
