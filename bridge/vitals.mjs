import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'

/**
 * Your vitals, for the dash: heart-rate variability and sleep against their
 * two-week baselines, this week's training load against a usual week, and the
 * latest activities — from the training connectors on the claude.ai account.
 *
 * Tredict supplies HRV and sleep, Strava the activities. As with the calendar
 * and inbox (createPersonal in dash.mjs), the page cannot reach a claude.ai
 * connector, so a small read-only Haiku run fetches them every
 * JARVIS_VITALS_REFRESH_MIN minutes (60 by default; 0 turns it off). Each run
 * costs a little of the Claude usage allowance.
 *
 * One thing is done differently: the numbers are read off the tool results
 * themselves, never out of the model's reply. The model's only job is to call
 * three tools, so a health figure it could mis-copy never reaches the screen,
 * and the training load is arithmetic done here rather than by a model.
 */

const HRV = 'mcp__claude_ai_Tredict__hrv-list'
const SLEEP = 'mcp__claude_ai_Tredict__sleep-list'
const ACTIVITIES = 'mcp__claude_ai_Strava__list_activities'
const TOOLS = new Set([HRV, SLEEP, ACTIVITIES])

const DAY_MS = 86_400_000
/** This week's load is measured against the average week of the last four. */
const HISTORY_DAYS = 28
/** As with the calendar: a failed read tries again soon, then waits. */
const RETRY_MINUTES = [2, 5, 10]

const EMPTY = {
  at: 0,
  error: null,
  hrv: null,
  sleep: null,
  load: null,
  recent: [],
  notes: { hrv: null, sleep: null, activities: null },
}

/** The background read may call the three vitals tools and nothing else. */
async function canUseTool(name, input) {
  return name === 'ToolSearch' || TOOLS.has(name)
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: 'Read-only: the three vitals tools only.' }
}

/** A tool result's text, whichever shape its content came in. */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (c?.type === 'text' ? c.text : '')).join('\n')
}

/** Why a source gave nothing, in a few words for the dash. */
function why(result) {
  if (!result) return 'not connected'
  if (/full access/i.test(result.text)) return 'needs Tredict plan'
  return result.error ? 'unavailable' : 'no readings'
}

/**
 * The newest reading in a Tredict list: date tags (YYYYMMDD) each holding a
 * [value, two-week baseline] pair. The exact layout could not be seen when
 * this was written — the account it was built on lacks the plan these lists
 * need — so the pair is accepted in JSON at any depth, or in plain text.
 */
export function latestReading(text) {
  let best = null
  const take = (tag, pair) => {
    const [value, baseline] = Array.isArray(pair?.[0]) ? pair[0] : (pair ?? [])
    const v = Number(value)
    if (!Number.isFinite(v) || v <= 0 || (best && tag <= best.tag)) return
    const b = Number(baseline)
    best = { tag, value: v, baseline: Number.isFinite(b) && b > 0 ? b : null }
  }
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return
    for (const [k, v] of Object.entries(node)) {
      if (/^\d{8}$/.test(k) && Array.isArray(v)) take(k, v)
      else walk(v, depth + 1)
    }
  }
  try {
    walk(JSON.parse(text), 0)
  } catch {
    /* not JSON: the text scan below */
  }
  if (!best) {
    for (const m of text.matchAll(/(\d{8})\D{0,6}\[\s*\[?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+|null)/g)) take(m[1], [m[2], m[3]])
  }
  if (!best) return null
  const t = best.tag
  return { date: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`, value: best.value, baseline: best.baseline }
}

/** Tredict's sleep total, in minutes. Its unit is not documented, so it is
 *  read from the size of the number: a night is hours, minutes or seconds. */
const sleepMinutes = (v) => (v > 1440 ? v / 60 : v > 24 ? v : v * 60)

/** Strava's list, reduced to what the dash shows. Newest first. */
function parseActivities(text) {
  const list = JSON.parse(text)?.activities
  if (!Array.isArray(list)) return null
  return list.map((a) => {
    const s = a.summary ?? {}
    return {
      name: String(a.name ?? a.sport_type ?? 'Activity').slice(0, 80),
      sport: String(a.sport_type ?? '').slice(0, 30),
      // Local time with no offset, as Strava gives it: the time on the watch.
      start: String(a.start_local ?? '').slice(0, 25),
      km: s.distance > 0 ? Math.round(s.distance / 100) / 10 : null,
      minutes: s.moving_time > 0 ? Math.round(s.moving_time / 60) : null,
      effort: Number.isFinite(s.relative_effort) ? s.relative_effort : null,
    }
  })
}

/**
 * This week's training load: Strava's relative effort over the last seven
 * days, against the average week of the last four. Sessions without heart
 * rate carry no effort and count as sessions only. Null when nothing in the
 * four weeks has an effort to add up.
 */
export function trainingLoad(list, now = Date.now()) {
  let week = 0
  let month = 0
  let sessions = 0
  let rated = 0
  for (const a of list) {
    // No offset, so this parses as local time — the same clock as `now`.
    const t = Date.parse(a.start)
    if (!Number.isFinite(t) || now - t > HISTORY_DAYS * DAY_MS) continue
    if (now - t <= 7 * DAY_MS) {
      sessions++
      week += a.effort ?? 0
    }
    month += a.effort ?? 0
    if (a.effort != null) rated++
  }
  if (!rated) return null
  const typical = month / (HISTORY_DAYS / 7)
  return {
    week: Math.round(week),
    typical: Math.round(typical),
    ratio: typical > 0 ? Math.round((week / typical) * 10) / 10 : null,
    sessions,
  }
}

export function createVitals() {
  const everyMinutes = Number(process.env.JARVIS_VITALS_REFRESH_MIN ?? 60)
  const enabled = everyMinutes > 0
  let data = null
  let running = false
  let failures = 0
  let retry = null
  const listeners = new Set()

  /** One run: ask for the three tools, and keep what each one returned. */
  const read = async () => {
    const now = Date.now()
    const since = new Date(now - HISTORY_DAYS * DAY_MS).toLocaleDateString('en-CA')
    const twoWeeks = new Date(now - 14 * DAY_MS)
    twoWeeks.setUTCHours(0, 0, 0, 0)
    const prompt =
      'Call these three tools, once each, all in the same turn: ' +
      `${ACTIVITIES} with {"first": 50, "range_start": "${since}T00:00:00"}; ` +
      `${HRV} with {"endDate": "${twoWeeks.toISOString()}"}; ` +
      `${SLEEP} with {"endDate": "${twoWeeks.toISOString()}"}. ` +
      'If one is not available yet, load it with ToolSearch first: it may still be connecting. ' +
      'If a tool fails, do not retry it. Then reply with the one word: done.'
    const session = query({
      prompt,
      options: {
        model: 'haiku',
        settingSources: [],
        maxTurns: 6,
        cwd: homedir(),
        systemPrompt: 'You fetch training data with read-only tools. Call the tools you are asked to; never summarise them.',
        canUseTool,
      },
    })
    const names = new Map()
    const results = new Map()
    for await (const m of session) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_use' && TOOLS.has(b.name)) names.set(b.id, b.name)
        }
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          const name = b?.type === 'tool_result' ? names.get(b.tool_use_id) : null
          // A success is never replaced by a later failure of the same tool.
          if (name && (!results.has(name) || results.get(name).error)) {
            results.set(name, { error: b.is_error === true, text: resultText(b.content) })
          }
        }
      } else if (m.type === 'result') {
        break
      }
    }
    return results
  }

  const refresh = async () => {
    if (running || !enabled) return
    running = true
    try {
      const got = await read()
      const text = (name) => {
        const r = got.get(name)
        return r && !r.error ? r.text : null
      }
      let recent = null
      try {
        recent = text(ACTIVITIES) ? parseActivities(text(ACTIVITIES)) : null
      } catch {
        recent = null
      }
      const hrv = text(HRV) ? latestReading(text(HRV)) : null
      const sleep = text(SLEEP) ? latestReading(text(SLEEP)) : null
      if (!recent && !hrv && !sleep) {
        const said = [...got].map(([n, r]) => `${n.split('__').pop()}: ${why(r)}`).join(', ')
        throw new Error(said ? `no source answered (${said})` : 'no vitals tool was called')
      }
      data = {
        at: Date.now(),
        error: null,
        hrv: hrv && {
          value: Math.round(hrv.value),
          baseline: hrv.baseline && Math.round(hrv.baseline),
          date: hrv.date,
        },
        sleep: sleep && {
          minutes: Math.round(sleepMinutes(sleep.value)),
          baselineMinutes: sleep.baseline && Math.round(sleepMinutes(sleep.baseline)),
          date: sleep.date,
        },
        load: recent ? trainingLoad(recent) : null,
        recent: (recent ?? []).slice(0, 3),
        notes: {
          hrv: hrv ? null : why(got.get(HRV)),
          sleep: sleep ? null : why(got.get(SLEEP)),
          activities: recent ? null : why(got.get(ACTIVITIES)),
        },
      }
      failures = 0
      clearTimeout(retry)
      const n = data.notes
      console.log(
        `[jarvis] vitals refreshed (HRV ${n.hrv ?? 'read'}, sleep ${n.sleep ?? 'read'}, ` +
          `${data.recent.length ? `${recent.length} activities` : `activities ${n.activities}`})`,
      )
    } catch (err) {
      failures += 1
      const wait = RETRY_MINUTES[failures - 1]
      clearTimeout(retry)
      if (wait) retry = setTimeout(refresh, wait * 60_000)
      console.warn(`[jarvis] vitals refresh failed: ${err?.message ?? err}` + (wait ? ` — trying again in ${wait} min` : ''))
      data = {
        ...EMPTY,
        ...(data ?? {}),
        at: Date.now(),
        error: wait ? `Couldn't read your vitals — trying again in ${wait} min.` : 'Your vitals could not be read.',
      }
    } finally {
      running = false
    }
    for (const fn of listeners) fn(data)
  }

  return {
    get: () => data ?? (enabled ? null : { ...EMPTY, error: 'Vitals are off (JARVIS_VITALS_REFRESH_MIN is 0).' }),
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    enabled,
    everyMinutes,
    start() {
      if (!enabled) return
      // After the calendar's first read, so the two runs do not start together.
      setTimeout(refresh, 45_000)
      setInterval(refresh, everyMinutes * 60_000)
    },
    refresh,
  }
}
