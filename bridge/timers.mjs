import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Timers and reminders JARVIS keeps, and says out loud when they are due.
 *
 * A timer is a due time held here on the bridge, not a countdown drawn on the
 * page, so it survives a reload, a closed window and a bridge restart (saved
 * in ~/.jarvis/timers.json). When one is due, every open window gets it as a
 * nudge — the path the calendar alerts take — and JARVIS says it, through
 * quiet hours too, because the user set it themselves. One that falls due
 * with no window open is said, late and saying so, when the next one connects.
 */

const DIR = join(homedir(), '.jarvis')
const FILE = join(DIR, 'timers.json')
const MAX = 20
const MIN_MS = 5_000
const MAX_MS = 24 * 60 * 60_000
/** A timer that went off with nobody here is still worth saying this long after. */
const LATE_MS = 60 * 60_000
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

let seq = 0
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`

/** "10 minutes", "1 hour 30 minutes", "45 seconds" — for speaking. */
export function spokenDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const part = (n, word) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '')
  if (!h && !m) return part(s, 'second') || '0 seconds'
  // Seconds only matter on a short timer.
  return [part(h, 'hour'), part(m, 'minute'), h || m >= 10 ? '' : part(s, 'second')].filter(Boolean).join(' ')
}

/** A length as it reads before "timer": "10-minute", "1-hour-30-minute". */
export function timerLength(ms) {
  return spokenDuration(ms)
    .replace(/(\d+) (hour|minute|second)s?/g, '$1-$2')
    .replace(/ /g, '-')
}

/** How a timer is named aloud: "your pasta timer", "your 10-minute timer". */
const timerName = (t) => (t.label ? `your ${t.label} timer` : `your ${timerLength(t.ms ?? 0)} timer`)

/** What he says when a timer is due — or, when nobody was here, how late. */
export function dueLine(t, lateMs = 0) {
  const late = lateMs >= 60_000 ? spokenDuration(Math.round(lateMs / 60_000) * 60_000) : ''
  if (t.at) {
    const what = t.label ? `: ${t.label}` : ''
    return late ? `Sir, a reminder for ${t.at}${what}. That was ${late} ago.` : `Sir, it's ${t.at}${what}.`
  }
  return late ? `Sir, ${timerName(t)} went off ${late} ago.` : `Sir, ${timerName(t)} is up.`
}

const valid = (t) => t && typeof t.id === 'string' && Number.isFinite(t.due)

export function createTimers() {
  let list = []
  try {
    list = (JSON.parse(readFileSync(FILE, 'utf8')).timers ?? []).filter(valid)
  } catch {
    /* none saved */
  }
  const timeouts = new Map()
  const fireListeners = new Set()
  const changeListeners = new Set()
  /** Due while no window was open: said when the next one connects. */
  let missed = []

  const summary = () =>
    [...list]
      .sort((a, b) => a.due - b.due)
      .map(({ id, label, due, at, ms }) => ({ id, label: label ?? null, due, at: at ?? null, ms: ms ?? null }))
  const changed = () => {
    try {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(FILE, JSON.stringify({ timers: list }, null, 2))
    } catch (err) {
      console.warn(`[jarvis] timers not saved: ${err?.message ?? err}`)
    }
    for (const fn of changeListeners) fn(summary())
  }
  const nudge = (t, lateMs) => ({ kind: 'timer', text: dueLine(t, lateMs), quiet: false, at: Date.now() })

  const fire = (id) => {
    const t = list.find((x) => x.id === id)
    timeouts.delete(id)
    if (!t) return
    list = list.filter((x) => x !== t)
    if (fireListeners.size) {
      const n = nudge(t, Date.now() - t.due)
      console.log(`[jarvis] timer due: ${n.text}`)
      for (const fn of fireListeners) fn(n)
    } else {
      missed.push(t)
    }
    changed()
  }
  const arm = (t) => {
    clearTimeout(timeouts.get(t.id))
    timeouts.set(t.id, setTimeout(() => fire(t.id), Math.max(0, t.due - Date.now())))
  }

  // Saved timers carry on across a restart; long-dead ones are dropped.
  list = list.filter((t) => Date.now() - t.due <= LATE_MS)
  list.forEach(arm)

  return {
    list: summary,
    onChange(fn) {
      changeListeners.add(fn)
      return () => changeListeners.delete(fn)
    },
    /** A window that can speak. Due timers reach it; any that went off while
     *  no window was open are said to it now. */
    onFire(fn) {
      fireListeners.add(fn)
      const now = Date.now()
      const late = missed.filter((t) => now - t.due <= LATE_MS)
      missed = []
      for (const t of late) fn(nudge(t, now - t.due))
      return () => fireListeners.delete(fn)
    },
    /** A timer for a duration, or a reminder at a clock time (HH:MM, local). */
    set({ seconds, minutes, hours, at, label }) {
      if (list.length >= MAX) throw new Error(`There are already ${MAX} timers; cancel one first.`)
      let due
      let ms = null
      let atText = null
      if (at) {
        const m = HHMM.exec(String(at).trim())
        if (!m) throw new Error('at must be HH:MM, 24-hour, local time.')
        const d = new Date()
        d.setHours(Number(m[1]), Number(m[2]), 0, 0)
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
        due = d.getTime()
        atText = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      } else {
        ms = Math.round(((Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60 + (Number(seconds) || 0)) * 1000)
        if (!(ms >= MIN_MS)) throw new Error('A timer needs at least 5 seconds.')
        if (ms > MAX_MS) throw new Error('A timer can run for at most 24 hours; for a clock time, use at.')
        due = Date.now() + ms
      }
      const t = { id: newId(), label: String(label ?? '').trim().slice(0, 60) || null, due, ms, at: atText }
      list.push(t)
      arm(t)
      changed()
      return {
        id: t.id,
        label: t.label,
        due: new Date(due).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        in: spokenDuration(due - Date.now()),
      }
    },
    /** Cancel by label or id, 'all', or — with nothing named — the only one.
     *  Returns what was cancelled. */
    cancel(which) {
      const w = String(which ?? '').trim().toLowerCase()
      const gone =
        w === 'all'
          ? list
          : w
            ? list.filter((t) => t.id === w || (t.label ?? '').toLowerCase() === w)
            : list.length === 1
              ? list
              : []
      for (const t of gone) {
        clearTimeout(timeouts.get(t.id))
        timeouts.delete(t.id)
      }
      if (gone.length) {
        list = list.filter((t) => !gone.includes(t))
        changed()
      }
      return gone.map((t) => t.label ?? (t.at ? `the ${t.at} reminder` : `the ${timerLength(t.ms ?? 0)} timer`))
    },
  }
}

const ok = (t) => ({ content: [{ type: 'text', text: t }] })
const failed = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

/** @param {ReturnType<typeof createTimers>} timers */
export function timersServer(timers) {
  return createSdkMcpServer({
    name: 'jarvis_timers',
    version: '1.0.0',
    instructions:
      'Timers and reminders, kept on this machine and said out loud when due — through quiet hours too. For any ' +
      'timer or reminder use timer_set; never draw a countdown on a blade or panel, which keeps no time and cannot ' +
      'speak. The dash shows the nearest one counting down. timer_list says what is running and how long is left; ' +
      'timer_cancel stops one.',
    alwaysLoad: true,
    tools: [
      tool(
        'timer_set',
        'Set a timer (hours, minutes, seconds) or a reminder at a clock time (at: HH:MM, 24-hour, local). JARVIS says it out loud when it is due. label: a word or two for a timer ("pasta", "laundry"), or what to remind them of ("call Mum").',
        {
          hours: z.number().min(0).optional().catch(undefined),
          minutes: z.number().min(0).optional().catch(undefined),
          seconds: z.number().min(0).optional().catch(undefined),
          at: z.string().optional().catch(undefined),
          label: z.string().optional().catch(undefined),
        },
        async (args) => {
          try {
            const t = timers.set(args)
            return ok(`Set${t.label ? ` (${t.label})` : ''}: due at ${t.due}, in ${t.in}.`)
          } catch (err) {
            return failed(String(err?.message ?? err))
          }
        },
      ),
      tool('timer_list', 'The timers and reminders running, soonest first, with how long each has left.', {}, async () => {
        const now = Date.now()
        const list = timers.list()
        if (!list.length) return ok('No timers are running.')
        return ok(
          JSON.stringify(
            list.map((t) => ({
              label: t.label,
              kind: t.at ? 'reminder' : 'timer',
              due: new Date(t.due).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
              left: Math.max(0, Math.round((t.due - now) / 1000)) + ' seconds',
            })),
          ),
        )
      }),
      tool(
        'timer_cancel',
        'Cancel a timer or reminder by its label, or "all". With nothing named, cancels the only one running.',
        { which: z.string().optional().catch(undefined) },
        async (args) => {
          const gone = timers.cancel(args.which)
          if (gone.length) return ok(`Cancelled: ${gone.join(', ')}.`)
          const running = timers.list()
          return failed(
            running.length
              ? `No timer matches that. Running: ${running.map((t) => t.label ?? (t.at ? `reminder at ${t.at}` : 'unlabelled timer')).join(', ')}.`
              : 'No timers are running.',
          )
        },
      ),
    ],
  })
}
