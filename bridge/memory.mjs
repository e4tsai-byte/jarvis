import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * What JARVIS keeps between conversations.
 *
 * Two things, both plain JSON in ~/.jarvis/ so they can be read, edited or
 * deleted by hand:
 *
 *  - memory.json — lasting facts about the user, saved by the model with
 *    memory_remember when they come up ("remember that…", a preference, a
 *    person, a project) and written into every new session's system prompt.
 *  - thread.json — the conversation itself: the Agent SDK session to resume
 *    and the last few exchanges for the screen, so a page reload or a bridge
 *    restart picks up where it left off instead of starting cold.
 */

const DIR = join(homedir(), '.jarvis')
const FACTS_FILE = join(DIR, 'memory.json')
const THREAD_FILE = join(DIR, 'thread.json')
const MAX_FACTS = 200
/** How much memory rides in a session's prompt. The oldest facts give way first. */
const PROMPT_CHARS = 6000
/** A conversation stays resumable this long after its last word: after a
 *  night away, a fresh one. */
const RESUME_WINDOW_MS = 12 * 60 * 60_000
const HISTORY_MAX = 40
/** Nothing that looks like a secret is written down, whatever the model thinks
 *  it heard: API keys, long card-like numbers, "password: …". */
const SECRET = /(sk_[a-z0-9]{10,}|sk-[a-z0-9-]{10,}|eyJhbGci|\b\d{13,19}\b|\bpass(word|code)\s*[:=]|\bpin\s*[:=])/i

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(file, data) {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (err) {
    console.warn(`[jarvis] could not save ${file}: ${err?.message ?? err}`)
  }
}
const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** Lasting facts about the user. */
export function createMemory() {
  const loaded = readJson(FACTS_FILE, [])
  let facts = (Array.isArray(loaded) ? loaded : []).filter(
    (f) => f && typeof f.fact === 'string' && typeof f.id === 'string',
  )
  let next = facts.reduce((n, f) => Math.max(n, Number(f.id.slice(1)) || 0), 0) + 1
  const save = () => writeJson(FACTS_FILE, facts)

  return {
    list: () => facts,
    /** Returns the saved entry, the existing one if it was already known, or
     *  a reason it was refused. */
    add(text, topic) {
      const fact = clean(text, 300)
      if (!fact) return { error: 'Nothing to save.' }
      if (SECRET.test(fact)) return { error: 'Not saved: it looks like a secret, and secrets are never written down.' }
      const same = facts.find((f) => f.fact.toLowerCase() === fact.toLowerCase())
      if (same) return same
      const entry = { id: `m${next++}`, fact, topic: clean(topic, 40) || 'general', at: new Date().toISOString() }
      facts = [...facts, entry].slice(-MAX_FACTS)
      save()
      return entry
    },
    /** Removes every fact whose id is `query`, or whose text contains it. */
    remove(query) {
      const q = clean(query, 200).toLowerCase()
      if (!q) return []
      const gone = facts.filter((f) => f.id === q || f.fact.toLowerCase().includes(q))
      if (gone.length) {
        facts = facts.filter((f) => !gone.includes(f))
        save()
      }
      return gone
    },
    /** The facts as prompt lines, newest kept when there are too many. */
    prompt() {
      const lines = []
      let used = 0
      for (let i = facts.length - 1; i >= 0; i--) {
        const line = `- ${facts[i].fact}`
        if (used + line.length > PROMPT_CHARS) break
        lines.unshift(line)
        used += line.length + 1
      }
      return lines.join('\n')
    },
  }
}

/**
 * The conversation, across reloads and restarts.
 *
 * One thread at a time. The first face to connect claims it: that session
 * resumes it and writes to it. A face that connects while the owner is still
 * open gets a fresh session and leaves the thread alone — two processes
 * resuming one session would fork it, and each would remember half.
 */
export function createThread() {
  let data = readJson(THREAD_FILE, null)
  let owner = null
  /** Lines said before the SDK named the session — the first question
   *  usually arrives before it has — held until begin(). */
  let live = false
  let pending = []
  const save = () => writeJson(THREAD_FILE, data ?? {})
  const fresh = () =>
    Boolean(data && typeof data.sessionId === 'string' && Date.now() - (data.at ?? 0) < RESUME_WINDOW_MS)

  return {
    /** Claim the thread for a connection: what to resume and show, or null
     *  when another connection already holds it. */
    claim(conn) {
      if (owner) return null
      owner = conn
      live = false
      pending = []
      return fresh() ? { sessionId: data.sessionId, turns: data.turns ?? [] } : { sessionId: null, turns: [] }
    },
    release(conn) {
      if (owner === conn) owner = null
    },
    owns: (conn) => owner === conn,
    /** The SDK has said which session this is. A resumed one keeps its
     *  history; a new one starts clean. */
    begin(sessionId, resumed) {
      const keep = resumed || data?.sessionId === sessionId
      data = { sessionId, at: Date.now(), turns: [...(keep ? (data?.turns ?? []) : []), ...pending].slice(-HISTORY_MAX) }
      live = true
      pending = []
      save()
    },
    record(role, text, tag) {
      const said = clean(text, 2000)
      if (!said) return
      const turn = { role, text: said, ...(tag ? { tag } : {}) }
      if (!live) {
        pending = [...pending, turn].slice(-HISTORY_MAX)
        return
      }
      data.turns = [...(data.turns ?? []), turn].slice(-HISTORY_MAX)
      data.at = Date.now()
      save()
    },
    /** A resume that failed: start cold next time rather than fail the same
     *  way on every connect. */
    forget() {
      data = null
      save()
    },
  }
}

const ok = (t) => ({ content: [{ type: 'text', text: t }] })
const failed = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

/** The memory, as tools. */
export function memoryServer(memory) {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions: "Long-term memory of the user, kept between conversations in ~/.jarvis/memory.json.",
    alwaysLoad: true,
    tools: [
      tool(
        'memory_remember',
        'Save one lasting fact about the user — a preference, a person in their life, a routine, a project, where they live or work — as one short plain sentence in the third person ("They take their coffee black."). Use it when they share something worth knowing next time, or say "remember". Never save passwords, keys, card or account numbers.',
        { fact: z.string(), topic: z.string().optional().catch(undefined) },
        async (args) => {
          const saved = memory.add(args.fact, args.topic)
          return saved.error ? failed(saved.error) : ok(`Saved as ${saved.id}.`)
        },
      ),
      tool(
        'memory_forget',
        'Forget facts about the user: pass a memory id (m12) or words from the fact, and every fact containing them is removed.',
        { match: z.string() },
        async (args) => {
          const gone = memory.remove(args.match)
          return gone.length ? ok(`Forgot: ${gone.map((g) => g.fact).join(' | ')}`) : failed('Nothing matched.')
        },
      ),
      tool('memory_list', 'Everything remembered about the user, oldest first, with ids.', {}, async () =>
        ok(JSON.stringify(memory.list().map(({ id, fact, topic }) => ({ id, fact, topic })))),
      ),
    ],
  })
}
