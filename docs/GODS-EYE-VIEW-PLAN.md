# God's Eye View × JARVIS — deep dive and integration plan

**Goal:** give JARVIS a live, photorealistic view of the planet that it can
steer, question, and literally look at — by connecting it to
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (GEV).

**Status:** M0–M3 built and verified end to end. GEV fork
`e4tsai-byte/gods-eye-view`, branch `jarvis-link`, on upstream `79a0f09`;
JARVIS branch `world-view`. M4 (HUD status, `npm start -- --world`, README)
not started.

**What testing changed from the plan:**
- **Frame size.** GEV caps viewport captures at 200 KB for OpenAI's data
  channel, and on a real GPU every city frame exceeded it (captures came back
  empty). `captureViewportImage` now takes an optional `maxEncodedBytes`
  (GEV's own default unchanged); the link asks for 1.5 MB. Frames measure
  350–500 KB.
- **Two linked tabs.** "Newest page wins" let a replaced page reconnect and
  take the link back, forever. The bridge closes a replaced page with code
  4000, and that page now stops retrying and shows *IN ANOTHER TAB*.
- **First-run panel.** Open GEV at `?jarvis=1&welcome=0`, or its welcome
  panel covers the globe JARVIS is looking at.
- **Visibility.** A backgrounded GEV tab dropped the link right after a
  camera flight in the one run done that way. Keep GEV in its own visible
  window, which is the setup chosen anyway.

---

## TL;DR

- **GEV is a 3D globe of live public data** (aircraft, ships, satellites,
  earthquakes, fires, public CCTV, radio) with its own voice agent. That agent
  runs on OpenAI and drives the globe through **28 tools**.
- **The two projects have the same shape.** In both, a model decides and a
  browser page executes. GEV cleanly separates the agent (`gevRealtime.js`)
  from the hands (`createGevActionRunner` in `gevActions.js`), and the tool
  schemas are plain data (`GEV_REALTIME_TOOLS`).
- **The plan:** replace GEV's OpenAI brain with JARVIS's Claude brain. GEV
  keeps running in its own window. A small **link** module in GEV connects to
  the JARVIS bridge, and JARVIS gains a `jarvis_world` tool server: GEV's 28
  tools plus a new `world_look`, which hands Claude a live screenshot of the
  globe along with structured context for what is in view.
- **Cost of the change:** about 180 lines in a GEV fork (one new file plus
  ~6 lines across two files), and about 400 lines in JARVIS (one new bridge
  module plus wiring). No OpenAI key is needed; Claude replaces it.

---

## Part 1 — What God's Eye View is

### The product

A browser app that renders the Earth with CesiumJS and overlays live, public
signals. The author describes it as *"A spy-satellite simulator in your
browser — then you realize the sources are public and the data is real."*
It's MIT-licensed and very active (179 commits, weekly refactors), and it
reached #1 on GitHub Trending in August 2026.

| Layer | Source | Key needed? |
|---|---|---|
| Map stack: Esri satellite, OSM, **Google Photorealistic 3D** | Esri / OSM / Cesium ion / Google | Esri and OSM: no. **3D cities: free Cesium ion token** (personal, non-commercial) or a metered Google key |
| Live flights (11,000+) and military ADS-B | OpenSky, adsb.lol | No |
| Satellites (838, plus the Starlink shell) | CelesTrak | No |
| Earthquakes (24 h) | USGS | No |
| Public CCTV (~800 cameras: Austin, California, London), projected *into* the 3D city | City open-data APIs | No |
| Radio (up to 750 geolocated stations) | Radio Browser | No |
| Space launches (30 days), bikeshare, military installations | LL2, GBFS, OSM | No |
| Ships | AISStream | Free key |
| Active fires | NASA FIRMS | Free key |
| Traffic flow | TomTom (the simulation runs without it) | Free key |
| Bundled static data: 4,351 datacenters, 704 dams, 712 submarine cables | Local files | No |

**Other features:** cockpit mode (ride a tracked aircraft), click-to-track
with trails, sensor shaders (NVG, FLIR, CRT, Noir), a detection overlay,
cinematic scene tours, share links, and a voice "whiteboard" that draws real
boundary polygons, routes and distance arrows onto the globe.

### Its voice agent — the part that matters for JARVIS

- **Session:** the OpenAI Realtime API over WebRTC. The server mints a
  short-lived token, so the OpenAI key never reaches the browser
  (`server/providers/openai/realtime.js`).
- **28 tools**, with schemas in `server/providers/openai/tools.js` (plain
  JSON Schema, no imports):
  - **Direct:** `fly_to_location`, `adjust_camera_zoom`, `zoom_to_globe`,
    `move_camera`, `frame_overhead`, `fly_route`
  - **Operate:** `set_layer_visibility`, `set_visual_style`, `set_map_stack`,
    `set_hud`, `set_detection`, `set_post_processing`, `set_panel_open`,
    `show_data_layers_menu`, `set_context_mode`, `control_cockpit`,
    `control_scene`, `control_cctv`, `control_radio`
  - **Track:** `track_entity`, `stop_tracking`, `select_nearest_aircraft`
  - **Annotate:** `annotate_map`, `clear_annotations`
  - **Understand:** `get_entity_context`, `get_current_view_state`,
    `analyst_query`, `next_iss_pass`
- **Executor:** `createGevActionRunner({viewer, styleManager, dataManager,
  sceneDirector, annotations, placeSearch})` returns one function,
  `runGevAction(name, args, {signal, isCurrent})`. It returns result objects
  written for a model to read: `{ok, …state}`, with static error strings so a
  place name can't smuggle instructions into the model.
- **Playbook:** `server/providers/openai/instructions.js` (~4.7k tokens) holds
  rules learned the hard way: the "counting contract" (every count states its
  scope), cockpit refusals, "confirm only on `ok=true`", and annotation
  etiquette.
- **Seeing:** `captureViewportImage()` grabs the Cesium canvas as a JPEG of up
  to 1200px. It renders a fresh frame first, rejects black frames, and refuses
  when the tab is hidden rather than return a stale frame. At street level, the
  agent reads signage from this screenshot.
- **Spend guard:** cost readout next to the mic, a $2 warning and a $5 hard cap.

### Architecture

- Vanilla JS, CesiumJS and Vite. The server side is a set of Vite-middleware
  proxies (`server/providers/*`) with SSRF guards. All private keys stay on the
  server, except the Google Maps and Cesium ion keys, which the browser needs.
- The dev server binds to localhost and sends `X-Frame-Options: DENY` and
  `frame-ancestors 'none'`, to protect the in-app key-entry panel.
- Requires Node 24.14+ or 26. This machine has Node 26.8.1, so that's fine.

### Its policy line

> This project models events, assets, infrastructure, and systems […] It does
> not build features for named-person search, face recognition, or tracking
> individuals. People are not a query type here.

This integration keeps to that line (see Guardrails).

---

## Part 2 — How it maps onto JARVIS

| Concept | God's Eye View | JARVIS today | After integration |
|---|---|---|---|
| **Brain** | OpenAI Realtime agent | Claude via Agent SDK (bridge) | **Claude drives both**; GEV's agent is unused |
| **Hands** | `runGevAction` in the GEV page | In-process MCP servers (`jarvis_ui`, `jarvis_chrome`, …) | `jarvis_world` forwards tool calls to `runGevAction` |
| **Eyes** | `captureViewportImage` (the globe) | `jarvis_eyes.look` (webcam, user-facing) | **`world_look`**: JARVIS sees the globe |
| **Knowing where it is** | `get_entity_context`, `get_current_view_state` | nothing | exposed as tools |
| **Showing things** | Annotations drawn on the globe | Blades and panels on the HUD | both; world snapshots can be mirrored to a blade |
| **Shape** | Browser executes, local Node server proxies | Browser executes, local Node bridge | same pattern, joined at the tool layer |

Both projects put the executor in a browser page, keep a local server for
secrets, and check origins on localhost. JARVIS's `jarvis_eyes` already does
exactly this round trip: the bridge asks the browser for an image, waits, and
hands it to Claude. `world_look` is the same pattern, pointed at the planet
instead of at the user.

---

## Part 3 — Options considered

| Option | Verdict | Why |
|---|---|---|
| **A. Remote link.** GEV in its own window, driven by JARVIS over a WebSocket | **Chosen** | Reuses GEV's executor and screenshots unchanged, keeps every GEV security header, and needs small, reviewable diffs on both sides |
| B. Embed GEV inside a JARVIS blade (iframe) | Later, maybe | Blocked today by GEV's `frame-ancestors 'none'`, JARVIS's CSP (`frame-src`) and the blade embed allowlist. Unblocking weakens the protection around GEV's key panel, and two heavy WebGL apps in one tab will struggle |
| C. Click through GEV's UI with `jarvis_chrome` | Rejected | No code needed, but it requires writes mode, is slow and brittle, and returns nothing structured |
| D. Headless: import GEV's data providers into the bridge | Later, as a fallback | Answers "how many flights over Texas" without a window, but JARVIS sees nothing |
| E. Let JARVIS talk to GEV's own agent (`sendTextCommand`) | Rejected | Two brains and two voices, plus OpenAI costs, with JARVIS only relaying |

---

## Part 4 — The plan (option A)

```
 JARVIS face  (localhost:5180)                 God's Eye View  (localhost:4173)
 ┌─────────────────────────┐                   ┌──────────────────────────────┐
 │ HUD · voice · typing    │                   │ Cesium globe · live layers   │
 └──────────┬──────────────┘                   │ runGevAction(name, args)     │
            │ ws :8787  (agent socket)         │ captureViewportImage()       │
 ┌──────────▼──────────────────────────┐       │ src/jarvis/link.js  ◄─────┐  │
 │ JARVIS bridge  (Claude, Agent SDK)  │       └────────────────────────────┼──┘
 │   jarvis_world MCP server ──────────┼── ws :8787/world (executor link) ──┘
 │   (GEV's 28 tools + world_look)     │
 └─────────────────────────────────────┘
```

**Flow of one turn.** You say *"take me to Tokyo and show me the planes
overhead."* Claude calls `fly_to_location` and then `frame_overhead` on
`jarvis_world`. The bridge sends each call over `/world` to the GEV page,
where `runGevAction` runs it. The result (`{ok:true, count:14, …}`) comes back
to Claude, and JARVIS says *"Fourteen aircraft over Tokyo, sir."* If you then
ask *"what am I looking at?"*, Claude calls `world_look` and actually sees the
frame.

### In God's Eye View (a fork: `e4tsai-byte/gods-eye-view`, branch `jarvis-link`)

1. **`src/jarvis/link.js` (new, ~150 lines):** an opt-in WebSocket client.
   - Off unless the page is opened with `?jarvis=1` or `VITE_JARVIS_BRIDGE_URL`
     is set, so normal GEV use is untouched.
   - Connects to `ws://localhost:8787/world` and sends a greeting with the
     GEV commit.
   - Handles `{type:'run', id, name, args}` by calling `runGevAction` and
     replying with `{type:'result', id, result}`. Tool calls are aborted
     through the runner's `signal` if the bridge cancels a turn.
   - Handles `{type:'look', id}` by calling `captureViewportImage` and
     `get_entity_context`, then replying with the image and the context.
   - Reconnects with backoff, and shows a small **JARVIS LINK** chip so you
     can see when it's connected.
2. **`src/voice/gevRealtime.js` (~4 lines):** expose the runner the voice
   module already creates (`controller.runAction = runner`) and export
   `captureViewportImage`. **Why share rather than create a second runner:**
   the runner's setup installs per-viewer camera hooks. `initCameraVerbs`
   guards against running twice, but the view-target prewarm hook may not, and
   one runner means one owner of the camera.
3. **`src/standalone/tools.js` (~3 lines):** start the link after the voice
   commands initialise, and stop it on teardown.

These three changes are small enough to offer upstream as a pull request.

### In JARVIS

4. **`bridge/world.mjs` (new, ~250 lines):** the `jarvis_world` in-process
   MCP server.
   - **Loads the tool schemas from your GEV checkout** (`GEV_DIR`, default
     `~/Github/gods-eye-view`) instead of copying them, so when GEV changes a
     tool, JARVIS picks it up automatically. Schemas are converted with
     `z.fromJSONSchema`, which I've verified works for all 28 today. A schema
     that fails to convert is skipped and logged rather than breaking startup.
   - **Loads only the core tools up front:** `world_look`,
     `get_current_view_state`, `get_entity_context`, `fly_to_location`,
     `set_layer_visibility` and `analyst_query`. The other 22 load on demand
     through the SDK's tool search (`tool({alwaysLoad})` is per-tool). Loading
     all 28 would add ~6.5k tokens to every turn, including turns that have
     nothing to do with the globe.
   - **`world_look` (new):** returns the viewport JPEG as an image block, plus
     the structured scene context (place, altitude, view scale, layers that are
     on). This is the "literally seeing" part.
   - **Server instructions:** a condensed version (~1.5k tokens) of GEV's
     playbook: the counting contract, cockpit refusals, "confirm only
     `ok=true`", "prefer names over coordinates", annotation etiquette, and
     "a bare 'stop' means stop the camera".
   - **Results pass through unchanged.** GEV already designed them for a model
     to read, including the prompt-injection-resistant error text.
5. **`bridge/server.mjs`:**
   - **A new `/world` WebSocket path** that accepts only GEV's origin
     (`http://localhost:4173`, or `GEV_ORIGIN`), one link at a time (the
     newest wins). It uses the same id-correlated request/reply with timeouts
     as the existing `ask`, with longer timeouts for camera flights.
   - **Protocol separation:** the world socket is an executor, never a user.
     It can answer `run` and `look` requests and nothing else, so it can never
     start a Claude turn. This matters because port 4173 already falls inside
     the dev-port range the main agent socket accepts.
   - **Registers `jarvis_world`** only when a GEV checkout is found.
   - **Tool permissions:** `decideTool` allows `jarvis_world` in read-only
     mode, like `jarvis_ui`, because it only moves a view on your own screen.
     It's named explicitly so the verb rules don't mistake `set_*` for a write.
   - **Health:** `/health` reports `world: true/false`.
   - **System prompt:** two lines. JARVIS has a world view it can steer and
     look at, and when the link is down it says so and suggests opening GEV.
6. **JARVIS face:** a **WORLD** entry in the SYSTEMS rail that lights up when
   the link is live, and (optional) each `world_look` snapshot mirrored to a
   blade, so you see what JARVIS saw. That goes through a temp file and the
   bridge's existing `/file` endpoint, which already serves images from the
   temp directory.
7. **`scripts/start.mjs`:** an optional `--world` flag that also starts GEV's
   dev server, so `npm start -- --world` brings up the brain, the face and the
   world with one command.

### Why each piece

| Piece | Why it's there |
|---|---|
| Separate GEV window | Keeps GEV's anti-framing protections, and gives each app its own WebGL context |
| Opt-in link (`?jarvis=1`) | Normal GEV behaviour is untouched, and the upstream PR stays low-risk |
| Shared runner | One owner of the camera; no duplicated per-viewer hooks |
| Schemas loaded from the checkout | One source of truth that follows GEV's weekly changes |
| Core tools loaded, rest on demand | Keeps ordinary JARVIS turns cheap and fast |
| `world_look` | Makes "seeing the world" literal rather than metadata |
| `/world` as executor-only | A page on port 4173 can run map actions but can never start a turn with your tools |
| Read-only allowance | Steering a map on your own screen isn't a real-world action |

---

## Part 5 — Guardrails

- **People are not a query type.** JARVIS's world instructions forbid
  identifying, describing, or following individual people in CCTV or
  street-level imagery, matching GEV's own policy. JARVIS also has a
  user-facing camera; the two are never combined.
- **Honest sight.** GEV refuses to capture while its window is hidden.
  JARVIS must then say it can't see the view right now, never describe a stale
  frame. The GEV window has to be **visible**: side by side, or on a second
  monitor.
- **Honest data.** GEV's disclaimer applies: data can be delayed, modelled or
  wrong. It's not for navigation or safety decisions.
- **Cost.**
  - No OpenAI key is needed.
  - Each `world_look` is roughly 1,000–1,600 image tokens on your Claude usage.
  - The core tools add ~2k tokens per turn, cached after the first.
  - `get_entity_context` calls Google Places only if you add a Google key,
    which is metered.
- **Security.**
  - Everything stays on localhost, with origins checked.
  - No secrets cross the link.
  - GEV keeps `frame-ancestors 'none'`.
  - The JARVIS write gate is unchanged.

---

## Part 6 — Milestones

Each milestone ends in something you can see working.

| # | Milestone | Done when |
|---|---|---|
| M0 | Fork and run GEV without keys | `npm ci && npm run doctor && npm run dev` shows the globe at `localhost:4173` |
| M1 | The link | A script sends `run get_current_view_state` through the bridge and gets GEV's real view state back |
| M2 | `jarvis_world` tools | Typing *"take me to Tokyo"*, *"turn on flights"*, *"how many flights over Texas?"* to JARVIS moves the globe and returns correct, scoped answers |
| M3 | Eyes | At street level, *"what am I looking at?"* is answered from the screenshot plus context; with GEV hidden, JARVIS says it can't see |
| M4 | Polish | WORLD status in the HUD, snapshot blade, `npm start -- --world`, and README updates |

Photorealistic 3D cities (a free Cesium ion token) are optional at every
milestone. They make M3 far more impressive, but nothing depends on them.

---

## Risks

| Risk | Mitigation |
|---|---|
| GEV changes quickly and could break the two seams (runner, capture) | Pin the fork to a known commit, keep the seams tiny, and verify on every GEV update |
| A future schema doesn't convert through zod | Check at load: skip and log that tool, and keep the rest |
| Two voices (GEV's mic and JARVIS) | While linked, hide or disable GEV's mic (open question 4) |
| Slow tools (camera flights with `waitForArrival`) | Timeouts per tool (30–45 s), and turn cancellation forwarded as abort |
| A hidden window means no sight | Honest error; the HUD shows the link state |

---

## Open questions

1. **Photorealistic 3D:** do you want to add a free Cesium ion token? It's
   what makes cities look real rather than flat satellite imagery.
2. **Window placement:** a second monitor, or side by side? GEV must be
   visible for JARVIS to see.
3. **Upstream:** should the GEV link be offered back to the author as a pull
   request, or stay in your fork?
4. **GEV's own mic:** hide it while JARVIS is linked, or keep both available?
