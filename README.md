# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Hold
**Space** and talk, and he does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and hold **Space** to talk.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and hold **Space** to talk.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  hold Space to talk                │        │  Node · bridge/server.mjs        │
  │  hold → clip → speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The microphone is hold-to-talk, and closed the rest of the time.

- **Hold Space to talk; release to send.** The audio track is disabled whenever
  Space is up, so nothing is transcribed and nothing counts as an interruption —
  a sniff, a keyboard or the room cannot cut JARVIS off or turn into a question.
  Holding Space while he speaks is the one way to interrupt him. Taps shorter
  than about a third of a second are ignored. (The clap that powers him on is
  separate, and only listens before he is on.)
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → the whole hold is recorded as one clip and sent
    to ElevenLabs Scribe via the bridge `/stt` endpoint, so a pause to think
    never splits a question in two.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    run only while Space is held.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

### The dash

Everything at once, on one screen. JARVIS's half, on the left, is one lit
field: the reactor's dust and glow fill it and fade into the right-hand column.
The orb floats at its centre, with its name and status above it and your
voice as a waveform below. Traces flow out of the orb to every readout, and
light pulses along them while JARVIS is thinking, using a tool or speaking.
Drag any readout wherever you like and its trace follows; the layout is
remembered in this browser. Double-click a readout to put it back, or **Reset
readouts** puts them all back.

- **Top row** — CPU and memory rings and a minute of network traffic, read by
  the bridge every two seconds while the dash is showing.
- **Left** — **Today** and **Inbox**: your next calendar events and your
  latest unread mail (sender and subject). A background Claude run refreshes
  them every 30 minutes. It uses Haiku and is read-only: it may only list
  events and search threads through your Google Calendar and Gmail connectors.
  Each refresh uses a little of your Claude usage;
  `JARVIS_PERSONAL_REFRESH_MIN` changes the interval and `0` turns it off.
- **Right** — the machine (memory, load, uptime) and the link (down, up,
  connected systems).
- **Conversation** — the whole session under the orb, scrollable, newest at
  the bottom. Typing opens beneath it.
- **World** — the live globe, with God's Eye View running (below).
- **Media**, in three tabs. **Expand** takes the hub full screen, with JARVIS
  docked top-right as over the globe; Esc or clicking the orb comes back.
  - *Live* — Al Jazeera English, DW, France 24, Sky News, ABC News (Australia)
    and NBC News, from each channel's own YouTube live stream. Muted until you
    ask for sound, and silent while you talk or JARVIS speaks. Full screen, all
    six play at once as a wall: click a tile to watch it alone, 🔊 to hear it.
  - *Markets* — your watchlist (up to 9 stocks, funds or coins; add with the
    **+** box by ticker or company name, remove with × on hover) in three
    views: **Gallery**, a box per stock; **Compare**, their % change on one
    chart (tap a chip to draw or drop a line); **Single**, one stock big with
    its day stats. Ranges 1D · 5D · 1M · 1Y apply to all three. The watchlist,
    range and Compare's picks are saved on this machine in
    `~/.jarvis/watchlist.json`, so JARVIS can edit them by voice. Stocks come
    from Yahoo Finance, falling back to Nasdaq's public quote API when Yahoo
    rate-limits (its 5D is then one price a day, marked "daily closes"); crypto
    from CoinGecko. Delayed quotes, not for trading.
  - *Headlines* — the six channels' stories as a thumbnail grid, newest first,
    with a chip per channel. Pictures come from each feed, or — for Al Jazeera
    and DW, whose feeds carry none — from the story page's own preview image,
    fetched once by the bridge and cached. A story opens in JARVIS's reader;
    **Open original ↗** in its header, or ↗ on a card, opens the real page in a
    new tab.

Ask for any of it: *"Put Sky News on."* · *"Put all the news channels up."* ·
*"Listen to DW."* · *"Show me Nvidia's chart."* · *"Compare Nvidia and AMD over
the month, full screen."* · *"Add Tesla to my watchlist."* · *"Any headlines
about Ukraine?"* · *"How's Bitcoin doing?"*

### JARVIS sees the world

With [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (GEV)
beside it, JARVIS can steer a live 3D globe — real aircraft, ships, satellites,
earthquakes, fires and public cameras — and look at it. GEV lives in this repo,
in `world/`, and the bridge loads its 28 tools from there, plus `world_look`,
which hands Claude the current frame.

1. Install it once: `cd world && npm ci`. GEV needs Node 24.14+ or 26.
2. Start everything with `npm start -- --world`. It runs GEV's dev server with
   `GEV_FRAME_ANCESTORS` set to this page, which is what lets the globe load
   inside JARVIS. (Running GEV yourself? Put
   `GEV_FRAME_ANCESTORS=http://localhost:5180,http://127.0.0.1:5180` in its
   `.env`, with your JARVIS port.)
3. Click **INITIALISE**. The globe loads in the dash's World panel and the
   WORLD chip reads LINKED. GEV's own mic is off in this mode; JARVIS is the
   voice.
4. Ask: *"Take me to Tokyo."* · *"Turn on the flights layer."* · *"How many
   flights are in view?"* · *"What am I looking at?"*

**Two layouts, switched for you.** JARVIS opens on the dash, with the globe in
its World panel. Any world command brings the globe full screen, with JARVIS
docked as an orb top-right and the conversation in a card bottom-right; after a
quiet minute — no world commands, nobody touching the globe, JARVIS idle — it
slides back to the dash. **W**, clicking the orb, or **Expand** on the World
panel switches by hand. Space and Enter still reach JARVIS while the globe has
focus.

GEV can also run in a separate window at
`http://localhost:4173/?jarvis=1&welcome=0`; when both are open, the globe
inside JARVIS keeps the link. Design notes and what testing changed:
[docs/GODS-EYE-VIEW-PLAN.md](docs/GODS-EYE-VIEW-PLAN.md).

**Updating God's Eye View.** `world/` came in with its full history as a git
subtree, so newer work from its author merges straight in:

```bash
git subtree pull --prefix=world https://github.com/bilawalsidhu/gods-eye-view.git main
```

Its MIT licence is in `world/LICENSE`.

---

## Controls

| Key / phrase | Does |
|---|---|
| **Space** (hold) | Talk. The microphone is open only while Space is held; release to send. Holding it while he speaks cuts him off |
| **Enter** | Type instead of speaking (Enter sends, Escape closes) |
| **W** | Switch between the dash and the full-screen world view (with God's Eye View running) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |
| `GEV_DIR` | `world/` | Where God's Eye View lives, if not in this repo's `world/` |
| `GEV_ORIGIN` | `localhost:4173` | Page origins allowed to hold the world link |
| `JARVIS_PERSONAL_REFRESH_MIN` | `30` | Minutes between the dash's calendar and inbox refreshes; `0` turns them off |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
