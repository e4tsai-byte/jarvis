import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { WorldView } from './ui/WorldView'
import { Dash } from './ui/Dash'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchWorld,
  watchMedia,
  watchPersonal,
  watchVitals,
  watchConditions,
  watchSpotify,
  watchWatchlist,
  watchNudges,
  watchThread,
  watchAlerts,
  note,
  type Nudge,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now, driven by one key. Holding Space opens the
 * microphone — cutting him off if he is mid-answer — and releasing it sends
 * what was said; every event is legal in every phase. Nothing else opens the
 * mic, so a sniff or a keystroke can never interrupt him or become a question.
 */

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** Mishearings of his name — without these, "Travis, what's the weather" sends
 *  "Travis" on to the model as part of the question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  /** True while Space is held — the only time the microphone is open. */
  const holding = useRef(false)

  const goDormant = () => {
    clearIdle()
    silence()
    // Standing down closes the mic too, mid-hold or not.
    if (holding.current) {
      holding.current = false
      voice.current?.cancel()
    }
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /**
   * Back to standby after a turn. There is no listening window any more: the
   * mic used to stay open for a follow-up, which is also when a sniff or a
   * keystroke became a question. Now it opens only while Space is held.
   */
  const standBy = () => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('dormant')
  }

  // -- one turn -------------------------------------------------------------

  /**
   * One turn. `hidden` is a prompt the interface sends on its own — the
   * morning briefing — which puts his answer on screen with no "YOU" line;
   * `tag` labels that answer.
   */
  const respond = async (said: string, opts: { hidden?: boolean; tag?: 'briefing' } = {}): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    if (!opts.hidden) s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '', tag: opts.tag })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }, { shown: opts.hidden ? null : said, tag: opts.tag })

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Straight back to standby. A follow-up is one more hold of Space.
        standBy()
      }
    }
  }

  // -- voice ----------------------------------------------------------------

  /**
   * Cut him off, whatever he was doing. Holding Space while he thinks or
   * speaks is the barge-in, and a typed line uses it too — both deliberate,
   * which is why nothing else can trigger it any more.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  /** Space down: open the microphone, cutting him off if he is mid-answer. */
  const beginHold = () => {
    const v = voice.current
    if (!v || holding.current) return
    holding.current = true
    store.getState().setError(null)
    onSpeechStart()
    // Also stops anything said while idle — a voice demo, the audio test.
    silence()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    v.hold()
  }

  /** Space up: close the microphone and send what was said. */
  const endHold = () => {
    if (!holding.current) return
    holding.current = false
    store.getState().setPhase('thinking')
    voice.current?.release()
  }

  /** Focus went elsewhere mid-hold, so the release will never arrive here.
   *  Throw the hold away rather than leave the microphone open. */
  const cancelHold = () => {
    if (!holding.current) return
    holding.current = false
    voice.current?.cancel()
    standBy()
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    // A newer hold is already open, and that one owns the turn.
    if (holding.current) return

    // People still address him by name. Strip it rather than sending "jarvis"
    // to the model as the question. Nothing left — a tap, silence, or only his
    // name — goes back to standby.
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said || BARE_NAME.test(text)) {
      standBy()
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  /**
   * Typed instead of said. The same turn as a spoken one — no wake word, and it
   * cuts him off if he is mid-answer — it just arrives already transcribed.
   */
  const onTyped = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    const said = text.trim()
    if (!said) return
    store.getState().setError(null)
    onSpeechStart()
    void respond(said)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    // The WORLD VIEW light. The bridge pushes the link state on connect and on
    // every change, so a reconnect re-announces it.
    watchWorld((linked) => store.getState().setWorld(linked))
    // The media hub, switched by JARVIS's voice.
    watchMedia((cmd) => {
      const s = store.getState()
      const patch: Partial<typeof s.media> = {}
      if (cmd.tab) patch.tab = cmd.tab
      if (cmd.channel) patch.channel = cmd.channel
      if (cmd.symbol) patch.symbol = cmd.symbol
      if (cmd.tab === 'headlines') patch.filter = cmd.filter ?? ''
      if (cmd.sound) patch.sound = true
      if (cmd.view) patch.view = cmd.view
      if (cmd.liveView) patch.liveView = cmd.liveView
      // A one-off set stands in for the watchlist until cleared; any other
      // markets command puts the watchlist back.
      if (cmd.tab === 'markets') patch.oneOff = cmd.symbols ?? []
      s.setMedia(patch)
      // Full screen only when asked for. Otherwise the dash, so the answer is
      // on screen — unless the hub is already full screen, where it stays.
      if (cmd.expand === true) s.setLayout('media')
      else if (cmd.expand === false || s.layout === 'world') s.setLayout('dash')
    })
    // The calendar and inbox panel, after each background refresh.
    watchPersonal((data) =>
      store.getState().setPersonal(data as ReturnType<typeof store.getState>['personal']),
    )
    // Vitals, and the weather and threat level at home, after each read.
    watchVitals((data) => store.getState().setVitals(data as ReturnType<typeof store.getState>['vitals']))
    watchConditions((data) =>
      store.getState().setConditions(data as ReturnType<typeof store.getState>['conditions']),
    )
    // What Spotify last said was playing, whoever asked.
    watchSpotify((data) =>
      store.getState().setNowPlaying(data as ReturnType<typeof store.getState>['nowPlaying']),
    )
    // The saved watchlist and range, as the bridge holds them.
    watchWatchlist((data) =>
      store.getState().setWatchlist(data as ReturnType<typeof store.getState>['watchlist']),
    )
    // Things to say unprompted, held until he can (see "speaking first"), and
    // whether he may right now.
    watchNudges((n) => {
      nudges.current.push(n)
    })
    watchAlerts((data) => store.getState().setAlerts(data))
    // The conversation so far, when the bridge resumed it: back on screen for
    // a freshly loaded page, and the reconnect notice put right.
    watchThread(({ resumed, turns }) => {
      const s = store.getState()
      if (turns.length && s.turns.length === 0) {
        s.setTurns(turns.map((t) => ({ id: newId(), role: t.role, text: t.text, tag: t.tag })))
      }
      if (resumed && s.error?.startsWith('Bridge reconnected')) {
        s.setError('Bridge reconnected — the conversation carries on.')
      }
    })
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
        // With the bridge gone the link state is unknown: show it offline
        // until the bridge says otherwise.
        if (store.getState().world) store.getState().setWorld(false)
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await new Promise((r) => setTimeout(r, 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // One voice loop, started once, running until the page closes.
    // Hold-to-talk: the engine starts with the microphone closed, and Space
    // is the only thing that opens it.
    voice.current = await startVoice({
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

    store.getState().setPhase('dormant')
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- speaking first --------------------------------------------------------

  /**
   * Alerts from the bridge wait here until he can say them: not while the
   * user holds Space, not while he is thinking or speaking, and not until he
   * has been quiet for a moment. Simple ones he says from the bridge's own
   * sentence — several waiting are said together — and they go back to the
   * bridge as a note, so a follow-up question knows what was said. The
   * morning briefing is a real turn. A quiet-hours alert goes on screen only.
   */
  const nudges = useRef<Nudge[]>([])
  const idleSince = useRef(0)

  useEffect(() => {
    const unsub = useStore.subscribe((st, prev) => {
      if (st.phase === 'dormant' && prev.phase !== 'dormant') idleSince.current = Date.now()
    })
    const id = window.setInterval(() => {
      const s = store.getState()
      if (!nudges.current.length || s.phase !== 'dormant' || holding.current) return
      if (Date.now() - idleSince.current < 2500) return

      if (nudges.current[0].kind === 'briefing') {
        const [briefing] = nudges.current.splice(0, 1)
        if (briefing.prompt) void respond(briefing.prompt, { hidden: true, tag: 'briefing' })
        return
      }
      const batch = nudges.current.filter((n) => n.kind !== 'briefing' && n.text)
      nudges.current = nudges.current.filter((n) => n.kind === 'briefing')
      if (!batch.length) return
      const text = batch.map((n) => n.text).join(' ')
      s.pushTurn({ id: newId(), role: 'jarvis', text, tag: 'alert' })
      note(text)
      if (batch.every((n) => n.quiet)) return

      silence()
      const spk = createSpeaker()
      speaker.current = spk
      sfx.play('tool')
      s.setPhase('speaking')
      spk.say(text)
      void spk.end().then(() => {
        // Cut off by a hold of Space, which has already taken the phase.
        if (speaker.current !== spk) return
        speaker.current = null
        standBy()
      })
    }, 1000)
    return () => {
      unsub()
      window.clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        // A full-screen hub goes back to the dash first; standing him down
        // is the next press.
        if (store.getState().layout === 'media') {
          store.getState().setLayout('dash')
          return
        }
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space is the microphone: held, it is open; released, what was said is
      // sent. Before power-up it is the ignition key instead.
      if (e.code !== 'Space') return
      e.preventDefault()
      if (e.repeat) return

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else {
        beginHold()
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault()
      endHold()
    }

    // A Space released in another window never arrives here, so a hold still
    // open when focus leaves is thrown away rather than left recording.
    const onBlur = () => cancelHold()

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <WorldView />
      <Dash />
      <Hud onType={onTyped} />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
