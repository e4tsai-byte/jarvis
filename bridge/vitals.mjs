import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'

/**
 * Your vitals, for the dash: overnight heart-rate variability, the day's
 * stress and last night's sleep against your usual week, this week's training
 * load against a usual week, and the latest activity.
 *
 * Garmin supplies HRV, stress and sleep; Strava the activities and their
 * relative effort. As with the calendar and inbox (createPersonal in
 * dash.mjs), the page cannot reach a claude.ai connector, so a small
 * read-only Haiku run fetches them every JARVIS_VITALS_REFRESH_MIN minutes
 * (60 by default; 0 turns it off). Each run costs a little of the Claude
 * usage allowance.
 *
 * One thing is done differently: the numbers are read off the tool results
 * themselves, never out of the model's reply. The model's only job is to call
 * the tools, so a health figure it could mis-copy never reaches the screen,
 * and every average and ratio is arithmetic done here.
 */

const HRV = 'mcp__claude_ai_Garmin__get_hrv_status'
const STRESS = 'mcp__claude_ai_Garmin__get_stress'
const SLEEP = 'mcp__claude_ai_Garmin__get_sleep_summary'
const ACTIVITIES = 'mcp__claude_ai_Strava__list_activities'
const TOOLS = new Set([HRV, STRESS, SLEEP, ACTIVITIES])

const DAY_MS = 86_400_000
/** This week's load is measured against the average week of the last four. */
const HISTORY_DAYS = 28
/** Garmin days read: the latest, and the ones before it to call usual. */
const GARMIN_DAYS = 7
/** As with the calendar: a failed read tries again soon, then waits. */
const RETRY_MINUTES = [2, 5, 10]

const EMPTY = {
  at: 0,
  error: null,
  hrv: null,
  stress: null,
  sleep: null,
  load: null,
  recent: [],
  notes: { hrv: null, stress: null, sleep: null, activities: null },
}

/** The background read may call the vitals tools and nothing else. */
async function canUseTool(name, input) {
  return name === 'ToolSearch' || TOOLS.has(name)
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: 'Read-only: the vitals tools only.' }
}

/** A tool result's text, whichever shape its content came in. */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (c?.type === 'text' ? c.text : '')).join('\n')
}

/** Why a source gave nothing, in a few words for the dash. An empty answer
 *  is a connector with nothing synced yet — a new link, or a watch that has
 *  not been near its phone. */
function why(result) {
  if (!result) return 'not connected'
  return result.error ? 'unavailable' : 'no data yet'
}

// ---------------------------------------------------------------------------
// Garmin
// ---------------------------------------------------------------------------

/** A record's nested fields as one level of dotted paths. */
function flatten(node, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flatten(v, key, out, depth + 1)
    else out[key] = v
  }
  return out
}

/** A record's day, YYYY-MM-DD, from whichever field carries one. */
function dayOf(flat) {
  for (const [k, v] of Object.entries(flat)) {
    if (/date|day|start/i.test(k) && /^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, 10)
  }
  return ''
}

/**
 * A Garmin list as flat daily records, newest first.
 *
 * Its HRV, stress and sleep lists could not be seen with data in them when
 * this was written — the account had only just been linked — so fields are
 * found by name rather than by an exact path: snake_case with units, the way
 * the connector writes its activities, or Garmin's own camelCase, at any
 * depth.
 */
export function garminDays(text) {
  let v
  try {
    v = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : v && typeof v === 'object' ? [v] : []
  return list
    .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
    .map((r) => {
      const flat = flatten(r)
      return { flat, date: dayOf(flat) }
    })
    .sort((a, b) => b.date.localeCompare(a.date))
}

/** The first number under a key that matches one of `want`, tried in order,
 *  and not `not`. Returns the key too, for the units its name carries. */
function pick(flat, want, not = /$^/) {
  for (const re of want) {
    for (const [k, v] of Object.entries(flat)) {
      if (!re.test(k) || not.test(k) || v === null || v === '' || typeof v === 'boolean') continue
      const n = Number(v)
      if (Number.isFinite(n)) return { key: k, value: n }
    }
  }
  return null
}

/** What a week of days calls usual: the days before the latest, three at least. */
const usual = (xs) => (xs.length >= 3 ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const round = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : null)

/** Last night's HRV in ms, against Garmin's own weekly average when it gives one. */
export function readHrv(text) {
  const days = garminDays(text)
  const value = (d) =>
    pick(d.flat, [/last.?night.?(avg|average)/i, /(overnight|nightly).?(avg|average)/i, /(^|\.)(hrv.?)?value$/i, /(^|\.)hrv$/i], /high|low|5.?min/i)
      ?.value
  const latest = days.find((d) => value(d) > 0)
  if (!latest) return null
  const weekly = pick(latest.flat, [/weekly.?(avg|average)/i, /baseline/i, /7.?day/i], /low|high|upper/i)?.value
  const status = Object.entries(latest.flat).find(([k, v]) => /status|feedback/i.test(k) && typeof v === 'string')?.[1]
  const earlier = days.filter((d) => d !== latest).map(value).filter((n) => n > 0)
  return {
    value: round(value(latest)),
    baseline: round(weekly) ?? round(usual(earlier)),
    status: status ? String(status).replace(/_/g, ' ').toLowerCase().slice(0, 30) : null,
    date: latest.date,
  }
}

/** Minutes from a duration field: by the unit its name carries or, failing
 *  that, by size — a night is hours, minutes or seconds. */
function minutesFrom(hit) {
  if (!hit) return null
  const { key, value } = hit
  if (/sec/i.test(key)) return value / 60
  if (/min/i.test(key)) return value
  if (/hour/i.test(key)) return value * 60
  return value > 1440 ? value / 60 : value > 24 ? value : value * 60
}

/** Last night's sleep in minutes, its score, and the week's usual. */
export function readSleep(text) {
  const days = garminDays(text)
  const minutes = (d) =>
    minutesFrom(
      pick(
        d.flat,
        [/(^|\.)(total.?)?(sleep.?)?duration/i, /(total|sleep).?(time|duration)/i, /duration/i],
        /deep|light|rem|awake|nap|unmeasurable|score/i,
      ),
    )
  const latest = days.find((d) => minutes(d) > 0)
  if (!latest) return null
  const score = pick(latest.flat, [/overall.*(score|value)/i, /sleep.?score/i, /score/i])?.value
  const earlier = days.filter((d) => d !== latest).map(minutes).filter((n) => n > 0)
  return {
    minutes: round(minutes(latest)),
    baselineMinutes: round(usual(earlier)),
    score: round(score),
    date: latest.date,
  }
}

/** The latest day's average stress (Garmin's 0–100), its peak, and the week's
 *  usual. Garmin writes -1 and -2 for "not enough data", so only positives count. */
export function readStress(text) {
  const days = garminDays(text)
  const average = (d) =>
    pick(d.flat, [/(avg|average).?stress/i, /stress.?(avg|average)/i, /(^|\.)(avg|average)(.?level)?$/i], /duration|time|percent/i)
      ?.value
  const latest = days.find((d) => average(d) > 0)
  if (!latest) return null
  const max = pick(latest.flat, [/max.?stress/i, /stress.?max/i, /(^|\.)max(.?level)?$/i], /duration|time/i)?.value
  const earlier = days.filter((d) => d !== latest).map(average).filter((n) => n > 0)
  return {
    average: round(average(latest)),
    baseline: round(usual(earlier)),
    max: round(max),
    date: latest.date,
  }
}

// ---------------------------------------------------------------------------
// Strava
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

export function createVitals() {
  const everyMinutes = Number(process.env.JARVIS_VITALS_REFRESH_MIN ?? 60)
  const enabled = everyMinutes > 0
  let data = null
  let running = false
  let failures = 0
  let retry = null
  const listeners = new Set()

  /** One run: ask for the four tools, and keep what each one returned. */
  const fetchAll = async () => {
    const since = new Date(Date.now() - HISTORY_DAYS * DAY_MS).toLocaleDateString('en-CA')
    const prompt =
      'Call these four tools, once each, all in the same turn: ' +
      `${ACTIVITIES} with {"first": 50, "range_start": "${since}T00:00:00"}; ` +
      `${HRV} with {"limit": ${GARMIN_DAYS}}; ` +
      `${STRESS} with {"limit": ${GARMIN_DAYS}}; ` +
      `${SLEEP} with {"limit": ${GARMIN_DAYS}}. ` +
      'If one is not available yet, load it with ToolSearch first: it may still be connecting. ' +
      'If a tool fails or returns nothing, do not retry it. Then reply with the one word: done.'
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
      const got = await fetchAll()
      const read = (name, parse) => {
        const r = got.get(name)
        if (!r || r.error) return null
        try {
          return parse(r.text)
        } catch {
          return null
        }
      }
      const recent = read(ACTIVITIES, parseActivities)
      const hrv = read(HRV, readHrv)
      const stress = read(STRESS, readStress)
      const sleep = read(SLEEP, readSleep)
      if (!recent && !hrv && !stress && !sleep) {
        const said = [...got].map(([n, r]) => `${n.split('__').pop()}: ${why(r)}`).join(', ')
        throw new Error(said ? `no source answered (${said})` : 'no vitals tool was called')
      }
      data = {
        at: Date.now(),
        error: null,
        hrv,
        stress,
        sleep,
        load: recent ? trainingLoad(recent) : null,
        recent: (recent ?? []).slice(0, 3),
        notes: {
          hrv: hrv ? null : why(got.get(HRV)),
          stress: stress ? null : why(got.get(STRESS)),
          sleep: sleep ? null : why(got.get(SLEEP)),
          activities: recent ? null : why(got.get(ACTIVITIES)),
        },
      }
      failures = 0
      clearTimeout(retry)
      const n = data.notes
      console.log(
        `[jarvis] vitals refreshed (HRV ${n.hrv ?? 'read'}, stress ${n.stress ?? 'read'}, sleep ${n.sleep ?? 'read'}, ` +
          `${recent ? `${recent.length} activities` : `activities ${n.activities}`})`,
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
