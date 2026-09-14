import { BRIDGE_HTTP_URL } from '../config'
import { getMic } from './audio'
import { caps } from './capabilities'

/**
 * The voice loop — hold to talk.
 *
 * The microphone is closed to everything except a held key. It used to be open
 * for the life of the page, listening for his name and for interruptions, and
 * that is exactly why a sniff, a keyboard or a chair could cut him off
 * mid-sentence: to an always-open mic every noise is a candidate for speech.
 * Holding Space is the one unambiguous signal that a person is talking to him,
 * so it is now the only one. (The clap that powers him up is separate — see
 * clap.ts — and only listens before he is on.)
 *
 * While nothing is held the audio track itself is disabled, not merely ignored:
 * no transcription, no barge-in, and the reactor cannot twitch at room noise
 * because there is no signal left to meter. Releasing the key is the end of the
 * utterance — no energy gate guessing where a sentence stops — so a pause to
 * think no longer splits one question into two turns.
 */

export type VoiceHandlers = {
  /** Live text while held (browser engine), or a listening cue (ElevenLabs). */
  onPartial: (text: string) => void
  /**
   * Everything said during one hold. Exactly one call per release — '' when
   * nothing intelligible was said, or the hold was only a tap — so the app
   * always knows when to stand back down. A cancelled or superseded hold gets
   * no call at all.
   */
  onUtterance: (text: string) => void
  /** Capture or transcription is unusable. Distinct from saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  /** Key down: open the mic and start capturing. */
  hold: () => void
  /** Key up: close the mic and send what was said. */
  release: () => void
  /** Abandon the current hold without sending anything (Escape, focus lost). */
  cancel: () => void
  stop: () => void
  /** True while the engine is usable. */
  live: () => boolean
}

/** A hold shorter than this is a tap, not speech: nothing is sent. */
const MIN_HOLD_MS = 300
/** Nobody holds this long on purpose; the clip is cut and sent. */
const MAX_HOLD_MS = 60_000
/** Below this a recording is container headers and silence. */
const MIN_AUDIO_BYTES = 1200

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice` for the D panel.
 * The field names predate hold-to-talk and are kept so the panel reads them
 * unchanged.
 */
export const diag = {
  /** Which input engine is running: 'elevenlabs' (Scribe) or 'browser'. */
  engine: 'browser',
  /** Whether the voice engine is usable. */
  running: false,
  /** Holds since load. */
  sessions: 0,
  /** The most recent transcript. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Always 0: there is no wake word any more. */
  wakes: 0,
  /** 'held' while the key is down, 'idle' otherwise. */
  mode: 'idle',
  /** Why the last hold went nowhere — '' when it was sent. */
  dropped: '',
  /** Transcripts passed to the app. */
  accepted: 0,
  /** 'recording' while held, 'transcribing' after release, '' otherwise. */
  holding: '',
  /** How long the last hold lasted, in ms. */
  waitedMs: 0,
  /** Always 0: nothing can barge in by itself any more. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
}

function drop(why: string) {
  diag.dropped = why
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/** One hold's worth of capture. */
type Engine = {
  begin: () => void
  /** Stop capturing and resolve what was said ('' for nothing). */
  end: () => Promise<string>
  /** Stop capturing and throw it away. */
  discard: () => void
}

function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

/**
 * ElevenLabs Scribe. The hold is recorded as one clip and transcribed whole
 * through the bridge, so the words cannot be cut short by a pause.
 */
function scribeEngine(stream: MediaStream, h: VoiceHandlers): Engine | null {
  if (typeof MediaRecorder === 'undefined') {
    h.onError('This browser cannot record audio — voice input is unavailable.')
    return null
  }
  const mime = pickMime()
  let recorder: MediaRecorder | null = null
  let parts: Blob[] = []

  const stopRecorder = (): Promise<Blob | null> =>
    new Promise((resolve) => {
      const rec = recorder
      recorder = null
      if (!rec) return resolve(null)
      const finish = () => {
        const blob = new Blob(parts, { type: rec.mimeType || mime || 'audio/webm' })
        parts = []
        resolve(blob)
      }
      rec.onstop = finish
      try {
        if (rec.state !== 'inactive') rec.stop()
        else finish()
      } catch {
        resolve(null)
      }
    })

  const transcribe = async (blob: Blob): Promise<string> => {
    if (blob.size < MIN_AUDIO_BYTES) return ''
    const t0 = performance.now()
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/stt`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      })
      diag.idleMs = Math.round(performance.now() - t0)
      if (!res.ok) {
        diag.restarts++
        diag.lastError = `stt ${res.status}`
        h.onError('That could not be transcribed — hold Space and try again.')
        return ''
      }
      const { text } = (await res.json()) as { text?: string }
      diag.lastError = ''
      return (text ?? '').trim()
    } catch (err) {
      diag.restarts++
      diag.lastError = String(err)
      h.onError('Could not reach the speech service.')
      return ''
    }
  }

  return {
    begin() {
      parts = []
      try {
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      } catch {
        recorder = new MediaRecorder(stream)
      }
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) parts.push(e.data)
      }
      recorder.start()
      // Scribe returns words only at the end, so the caption says "listening".
      h.onPartial('…')
    },
    async end() {
      const blob = await stopRecorder()
      return blob ? transcribe(blob) : ''
    },
    discard() {
      const rec = recorder
      recorder = null
      parts = []
      if (!rec) return
      rec.ondataavailable = null
      rec.onstop = null
      try {
        if (rec.state !== 'inactive') rec.stop()
      } catch {
        /* already stopped */
      }
    },
  }
}

/**
 * The keyless fallback: the browser's own SpeechRecognition, run only while
 * the key is held. It keeps its own capture, which the disabled track cannot
 * touch — and does not need to, since it is not running between holds.
 */
function browserEngine(h: VoiceHandlers): Engine | null {
  const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return null
  }
  let rec: any = null
  let active = false
  let finals = ''
  let interim = ''
  let settle: ((text: string) => void) | null = null
  const said = () => `${finals} ${interim}`.replace(/\s+/g, ' ').trim()

  const open = () => {
    rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-GB'
    rec.onresult = (e: any) => {
      interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript as string
        if (e.results[i].isFinal) finals += ` ${chunk}`
        else interim += chunk
      }
      if (active) h.onPartial(said())
    }
    rec.onerror = (ev: any) => {
      diag.lastError = String(ev.error ?? '')
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        h.onError('Microphone access was refused — voice input is unavailable.')
      }
    }
    rec.onend = () => {
      rec = null
      if (settle) {
        const done = settle
        settle = null
        done(said())
        return
      }
      // Still held, but the recogniser ended itself — it does, after a pause.
      // Carry on into a fresh session; what was said so far is kept.
      if (active) {
        diag.restarts++
        try {
          open()
        } catch {
          /* the release will send what there is */
        }
      }
    }
    rec.start()
  }

  return {
    begin() {
      finals = ''
      interim = ''
      settle = null
      active = true
      try {
        open()
      } catch {
        diag.lastError = 'start'
      }
    },
    end() {
      active = false
      return new Promise((resolve) => {
        if (!rec) return resolve(said())
        settle = resolve
        try {
          rec.stop()
        } catch {
          settle = null
          resolve(said())
        }
      })
    },
    discard() {
      active = false
      settle = null
      try {
        rec?.abort()
      } catch {
        /* already gone */
      }
      rec = null
    },
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Enabled while a key is held, disabled otherwise. */
function setMicOpen(stream: MediaStream, open: boolean) {
  for (const track of stream.getAudioTracks()) track.enabled = open
}

const idle: Voice = { hold() {}, release() {}, cancel() {}, stop() {}, live: () => false }

/**
 * Pick the engine and start it, with the microphone closed.
 *
 * The mic is opened once here so a denied permission is reported loudly rather
 * than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers): Promise<Voice> {
  let stream: MediaStream
  try {
    stream = await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return idle
  }

  const useScribe = caps().stt
  diag.engine = useScribe ? 'elevenlabs' : 'browser'
  const engine = useScribe ? scribeEngine(stream, h) : browserEngine(h)
  if (!engine) return idle
  setMicOpen(stream, false)
  diag.running = true

  let holding = false
  let heldAt = 0
  /** Bumped by every hold and cancel, so only the newest hold's words land. */
  let seq = 0
  let maxTimer: ReturnType<typeof setTimeout> | null = null

  const close = () => {
    holding = false
    if (maxTimer) clearTimeout(maxTimer)
    maxTimer = null
    setMicOpen(stream, false)
    diag.mode = 'idle'
  }

  const release = async () => {
    if (!holding) return
    const mine = seq
    const heldFor = performance.now() - heldAt
    close()
    diag.waitedMs = Math.round(heldFor)
    if (heldFor < MIN_HOLD_MS) {
      engine.discard()
      diag.holding = ''
      drop('a tap, not speech')
      h.onPartial('')
      h.onUtterance('')
      return
    }
    diag.holding = 'transcribing'
    const text = await engine.end()
    // A newer hold started while this one was transcribing. It owns the turn.
    if (mine !== seq) return
    diag.holding = ''
    h.onPartial('')
    if (!text) {
      drop('nothing intelligible in the hold')
      h.onUtterance('')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    diag.accepted++
    diag.dropped = ''
    h.onUtterance(text)
  }

  return {
    hold() {
      if (holding) return
      holding = true
      heldAt = performance.now()
      seq++
      diag.sessions++
      diag.mode = 'held'
      diag.holding = 'recording'
      setMicOpen(stream, true)
      engine.begin()
      maxTimer = setTimeout(() => void release(), MAX_HOLD_MS)
    },
    release: () => void release(),
    cancel() {
      if (!holding) return
      seq++
      close()
      engine.discard()
      diag.holding = ''
      drop('cancelled')
      h.onPartial('')
    },
    stop() {
      if (holding) {
        seq++
        close()
        engine.discard()
      }
      diag.running = false
    },
    live: () => diag.running,
  }
}
