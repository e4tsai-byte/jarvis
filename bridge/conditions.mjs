import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { kmBetween } from './alerts.mjs'
import { GEV_DIR } from './world.mjs'

/**
 * The conditions at home, for the dash: the weather and the air, and a threat
 * level from CALM to ALERT built from what is happening nearby — earthquakes,
 * fires, severe weather and bad air.
 *
 * Home is the place set for the earthquake alerts ("my home is Taipei"), so
 * there is one answer to where the user is, and it is theirs to give. Every
 * source is public and keyless except NASA FIRMS, which borrows the key God's
 * Eye View already holds for its fires layer. Read every ten minutes, and at
 * once when home changes.
 */

const TIMEOUT_MS = 10_000
const REFRESH_MS = 10 * 60_000
/** A tool asking about conditions older than this reads them again first. */
const STALE_MS = 15 * 60_000
/** NWS asks every client to name itself. */
const UA = 'jarvis-dashboard/1.0'
export const LEVELS = ['CALM', 'GUARDED', 'ELEVATED', 'ALERT']

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * FIRMS needs a free MAP_KEY. God's Eye View keeps one in world/.env for its
 * fires layer, and the same key serves here; FIRMS_MAP_KEY in the bridge's
 * own environment wins. Never logged: FIRMS carries it in the URL.
 */
function firmsKey() {
  if (process.env.FIRMS_MAP_KEY) return process.env.FIRMS_MAP_KEY.trim()
  try {
    return String(parseEnv(readFileSync(join(GEV_DIR, '.env'), 'utf8')).FIRMS_MAP_KEY ?? '').trim()
  } catch {
    return ''
  }
}

const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
}

/** The US EPA's bands for its air quality index. */
const aqiCategory = (aqi) =>
  aqi <= 50 ? 'Good' : aqi <= 100 ? 'Moderate' : aqi <= 150 ? 'Unhealthy for some' : aqi <= 200 ? 'Unhealthy' : aqi <= 300 ? 'Very unhealthy' : 'Hazardous'

const clampLon = (v) => Math.max(-180, Math.min(180, v))
const clampLat = (v) => Math.max(-90, Math.min(90, v))
const at3 = (v) => v.toFixed(3)

/** Now, and today's high and low, from Open-Meteo. Celsius and km/h. */
async function weatherAt({ lat, lon }) {
  const d = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${at3(lat)}&longitude=${at3(lon)}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto',
  )
  const c = d?.current
  if (typeof c?.temperature_2m !== 'number') throw new Error('no current weather')
  return {
    temp: c.temperature_2m,
    feels: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    wind: c.wind_speed_10m,
    gusts: c.wind_gusts_10m,
    code: c.weather_code,
    condition: WMO[c.weather_code] ?? 'Unknown',
    isDay: c.is_day === 1,
    high: d.daily?.temperature_2m_max?.[0] ?? null,
    low: d.daily?.temperature_2m_min?.[0] ?? null,
  }
}

async function airAt({ lat, lon }) {
  const c = (
    await getJson(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${at3(lat)}&longitude=${at3(lon)}&current=us_aqi,pm2_5`,
    )
  )?.current
  if (typeof c?.us_aqi !== 'number') throw new Error('no air quality')
  return { aqi: Math.round(c.us_aqi), category: aqiCategory(c.us_aqi), pm25: c.pm2_5 ?? null }
}

/** The last day's quakes of magnitude 2.5 and up within 1,000 km, from the
 *  USGS feed God's Eye View draws. */
async function quakesNear(home) {
  const d = await getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson')
  return (d?.features ?? [])
    .map((f) => {
      const [lon, lat] = f.geometry?.coordinates ?? []
      return { mag: f.properties?.mag, km: kmBetween(home, { lat, lon }), lat, lon }
    })
    .filter((q) => typeof q.mag === 'number' && Number.isFinite(q.km) && q.km <= 1000)
}

/**
 * Satellite fire detections within about 110 km over the last day, from NASA
 * FIRMS (VIIRS on NOAA-20, the source God's Eye View's fires layer uses).
 * Low-confidence pixels are left out; a lone hotspot is as often a factory
 * flare as a fire, which is why the scoring wants several.
 */
async function firesNear(home, key) {
  const dLon = 1 / Math.max(0.2, Math.cos((home.lat * Math.PI) / 180))
  const box = [clampLon(home.lon - dLon), clampLat(home.lat - 1), clampLon(home.lon + dLon), clampLat(home.lat + 1)]
  // Two days, trimmed to the last 24 hours: FIRMS counts days in UTC, so one
  // day is nearly empty just after midnight there.
  const res = await fetch(
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/VIIRS_NOAA20_NRT/${box.map(at3).join(',')}/2`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const [head = '', ...rows] = (await res.text()).trim().split('\n')
  const cols = head.split(',')
  if (!cols.includes('latitude')) throw new Error('FIRMS did not answer with CSV')
  const col = (row, name) => row[cols.indexOf(name)]
  const now = Date.now()
  const spots = []
  for (const line of rows) {
    const r = line.split(',')
    if (col(r, 'confidence') === 'l') continue
    const hhmm = String(col(r, 'acq_time') ?? '').padStart(4, '0')
    const t = Date.parse(`${col(r, 'acq_date')}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`)
    if (!Number.isFinite(t) || now - t > 86_400_000) continue
    const at = { lat: Number(col(r, 'latitude')), lon: Number(col(r, 'longitude')) }
    const km = kmBetween(home, at)
    if (Number.isFinite(km)) spots.push({ km, ...at })
  }
  const within = (d) => spots.filter((s) => s.km <= d).length
  const nearest = spots.reduce((a, s) => (!a || s.km < a.km ? s : a), null)
  return {
    within10: within(10),
    within25: within(25),
    within50: within(50),
    nearest: nearest?.km ?? null,
    at: nearest && { lat: nearest.lat, lon: nearest.lon },
  }
}

/** Open wildfires and storms — tropical cyclones among them — that NASA's
 *  EONET is tracking within about 1,500 km. */
async function eventsNear(home) {
  const box = [clampLon(home.lon - 15), clampLat(home.lat + 15), clampLon(home.lon + 15), clampLat(home.lat - 15)]
  const d = await getJson(
    `https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires,severeStorms&status=open&days=10&bbox=${box.join(',')}`,
  )
  const out = []
  for (const e of d?.events ?? []) {
    const last = (e.geometry ?? []).filter((g) => g.type === 'Point').at(-1)
    if (!last) continue
    const [lon, lat] = last.coordinates
    out.push({
      title: String(e.title ?? '').slice(0, 80),
      kind: e.categories?.some((c) => c.id === 'severeStorms') ? 'storm' : 'fire',
      km: kmBetween(home, { lat, lon }),
      lat,
      lon,
    })
  }
  return out
}

/** The US National Weather Service's active warnings — only where it has any. */
const inUS = (h) => h.lat > 17 && h.lat < 72 && h.lon > -180 && h.lon < -64

async function warningsAt(home) {
  if (!inUS(home)) return []
  const d = await getJson(`https://api.weather.gov/alerts/active?point=${home.lat.toFixed(4)},${home.lon.toFixed(4)}`, {
    accept: 'application/geo+json',
  })
  return (d?.features ?? [])
    .map((f) => ({ event: String(f.properties?.event ?? '').slice(0, 60), severity: f.properties?.severity }))
    .filter((w) => w.event)
}

/**
 * The threat level: the worst of what is nearby, with the reasons. Reasons
 * carry no units — the face converts distances for the user's locale.
 *
 *   ALERT     a strong quake close by, a tropical storm within 300 km, fire
 *             within 10 km, an extreme warning, hazardous air
 *   ELEVATED  a moderate quake close by, a storm within 800 km, several fires
 *             within 25 km, a severe warning, a thunderstorm, damaging gusts
 *   GUARDED   a felt quake, a storm within 1,500 km, fires within 50 km, a
 *             moderate warning, heavy rain or snow, dangerous heat, bad air
 */
export function assess({ weather, air, quakes, fires, events, warnings, home = null }) {
  const reasons = []
  // Each reason says what kind of hazard it is — the alerts phrase each kind
  // their own way — and where the globe should look: its own place when it
  // has one, home for the weather, a warning or the air.
  const add = (level, text, kind, { km = null, at = home } = {}) => {
    if (level <= 0) return
    const round = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)
    reasons.push({ level, text, kind, km: km === null ? null : Math.round(km), lat: round(at?.lat), lon: round(at?.lon) })
  }
  for (const q of quakes ?? []) {
    const level =
      (q.mag >= 6 && q.km <= 300) || q.mag >= 7 ? 3 : (q.mag >= 5 && q.km <= 300) || q.mag >= 6 ? 2 : (q.mag >= 4 && q.km <= 200) || q.mag >= 5 ? 1 : 0
    add(level, `M${q.mag.toFixed(1)} earthquake`, 'quake', { km: q.km, at: q })
  }
  if (fires) {
    const level = fires.within10 >= 5 ? 3 : fires.within25 >= 5 || fires.within10 >= 2 ? 2 : fires.within50 >= 3 ? 1 : 0
    add(level, `${fires.within50} fire hotspots`, 'hotspots', { km: fires.nearest, at: fires.at })
  }
  for (const e of events ?? []) {
    const level =
      e.kind === 'storm' ? (e.km <= 300 ? 3 : e.km <= 800 ? 2 : e.km <= 1500 ? 1 : 0) : e.km <= 50 ? 2 : e.km <= 150 ? 1 : 0
    add(level, e.title, e.kind === 'storm' ? 'storm' : 'wildfire', { km: e.km, at: e })
  }
  for (const w of warnings ?? []) add({ Extreme: 3, Severe: 2, Moderate: 1 }[w.severity] ?? 0, w.event, 'warning')
  if (weather) {
    if ([95, 96, 99].includes(weather.code)) add(2, weather.condition, 'weather')
    else if ([65, 67, 75, 82, 86].includes(weather.code)) add(1, weather.condition, 'weather')
    if (weather.gusts >= 90) add(2, 'Damaging gusts', 'weather')
    else if (weather.gusts >= 62) add(1, 'Strong gusts', 'weather')
    // The heat index bands: "danger" from 39°C, "extreme danger" from 51°C.
    if (weather.feels >= 51) add(2, 'Extreme heat', 'weather')
    else if (weather.feels >= 39) add(1, 'Dangerous heat', 'weather')
    if (weather.feels <= -25) add(2, 'Extreme cold', 'weather')
  }
  if (air) {
    add(air.aqi > 300 ? 3 : air.aqi > 200 ? 2 : air.aqi > 150 ? 1 : 0, `Air quality ${air.category.toLowerCase()}`, 'air')
  }
  reasons.sort((a, b) => b.level - a.level || (a.km ?? 0) - (b.km ?? 0))
  const level = reasons[0]?.level ?? 0
  return { level, label: LEVELS[level], reasons: reasons.slice(0, 3) }
}

/** @param {{ home: () => ({ name: string, lat: number, lon: number } | null) }} deps */
export function createConditions({ home }) {
  let data = null
  let running = false
  let lastHome = ''
  const listeners = new Set()
  const key = firmsKey()
  const homeKey = (h) => (h ? `${h.lat},${h.lon}` : '')

  const refresh = async () => {
    if (running) return
    running = true
    const h = home()
    lastHome = homeKey(h)
    try {
      if (!h) {
        data = { at: Date.now(), error: null, home: null, weather: null, air: null, threat: null }
        return
      }
      const reads = {
        weather: weatherAt(h),
        air: airAt(h),
        quakes: quakesNear(h),
        fires: key ? firesNear(h, key) : Promise.resolve(null),
        events: eventsNear(h),
        warnings: warningsAt(h),
      }
      const names = Object.keys(reads)
      const settled = await Promise.allSettled(Object.values(reads))
      const got = {}
      const missing = []
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') got[names[i]] = r.value
        else missing.push(names[i])
      })
      const sources = ['Open-Meteo', 'USGS', key ? 'NASA FIRMS' : null, 'NASA EONET', inUS(h) ? 'NWS' : null].filter(Boolean)
      // With every hazard feed down, a CALM would be a guess, not a reading.
      const hazardsRead = ['quakes', 'fires', 'events', 'warnings'].some((n) => n in got && !(n === 'fires' && !key))
      data = {
        at: Date.now(),
        error: missing.length ? `Couldn't read ${missing.join(', ')}.` : null,
        home: { name: h.name },
        weather: got.weather ?? null,
        air: got.air ?? null,
        threat: hazardsRead ? { ...assess({ ...got, home: h }), sources, missing } : null,
      }
      if (missing.length) console.warn(`[jarvis] conditions: ${missing.join(', ')} could not be read`)
    } catch (err) {
      console.warn(`[jarvis] conditions refresh failed: ${err?.message ?? err}`)
    } finally {
      running = false
      for (const fn of listeners) fn(data)
    }
  }

  return {
    get: () => data,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    refresh,
    /** Read now if what is held is older than STALE_MS or for another home. */
    async fresh() {
      if (!data || Date.now() - data.at > STALE_MS || homeKey(home()) !== lastHome) await refresh()
      return data
    },
    start() {
      setTimeout(refresh, 3000)
      setInterval(refresh, REFRESH_MS)
      // Home is changed by voice; the dash should follow without a restart.
      setInterval(() => {
        if (homeKey(home()) !== lastHome) void refresh()
      }, 30_000)
    },
  }
}

const ok = (t) => ({ content: [{ type: 'text', text: t }] })

/** The dash's conditions and vitals, as tools, so "how's the weather?" and
 *  "how did I sleep?" are answered from the same numbers the dash shows. */
export function statusServer(conditions, vitals) {
  return createSdkMcpServer({
    name: 'jarvis_status',
    version: '1.0.0',
    instructions:
      "What the dash shows about the user's surroundings and their training. Use these rather than a web search for the weather at home.",
    alwaysLoad: true,
    tools: [
      tool(
        'conditions_now',
        "Weather, air quality and the threat level at the user's home, as the dash shows them. Temperatures °C, wind km/h, distances km. The threat level runs CALM, GUARDED, ELEVATED, ALERT, from nearby earthquakes, fires, storms, weather warnings and air; reasons says why. If no home is set, ask where home is and set it with alerts_set.",
        {},
        async () => {
          const d = await conditions.fresh()
          if (!d?.home) return ok('No home is set. Ask where home is, then set it with alerts_set (home).')
          return ok(JSON.stringify(d))
        },
      ),
      tool(
        'vitals_now',
        "The user's vitals from the dash: last night's heart-rate variability, the day's stress (0–100) and last night's sleep, each against their usual week (Garmin); this week's training load — Strava relative effort — against their usual week; and their latest activities. notes says why anything is missing.",
        {},
        async () => ok(JSON.stringify(vitals.get() ?? { error: 'Not read yet; the first read runs shortly after start.' })),
      ),
    ],
  })
}
