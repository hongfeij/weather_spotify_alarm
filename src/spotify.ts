import type { Env, PickedTrack, PlaybackResult } from './types'
import { fetchWithTimeout } from './utils/http'

export async function spotifyToken(env: Env) {
  const r = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SPOTIFY_CLIENT_ID,
      client_secret: env.SPOTIFY_CLIENT_SECRET,
    }),
  })
  if (!r.ok) throw new Error(`token ${r.status}`)
  const j = (await r.json()) as any
  return j.access_token as string
}

// Exchange a stored refresh token for a user access token
export async function spotifyUserToken(env: Env) {
  if (!env.SPOTIFY_REFRESH_TOKEN) throw new Error('missing_refresh_token')
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)
  const r = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.SPOTIFY_REFRESH_TOKEN,
    }),
  })
  if (!r.ok) throw new Error(`user_token ${r.status}`)
  const j = (await r.json()) as any
  return j.access_token as string
}

/* =========================
   Helpers
   ========================= */
function randInt(n: number) { return Math.floor(Math.random() * n) }
function sample<T>(arr: T[]) { return arr[randInt(arr.length)] }
function shuffle<T>(arr: T[]) { for (let i = arr.length - 1; i > 0; i--) { const j = randInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]] } return arr }
function clamp01(n: number) { return Math.max(0, Math.min(1, n)) }
function rangeAround(target: number, width = 0.30) { const h = width / 2; return { min: clamp01(target - h), max: clamp01(target + h) } }


/* =========================
   Intent → query features
   ========================= */
export function moodKeywords(intent: any) {
  const llm = String(intent?.mood ?? '').toLowerCase().trim()
  if (llm) return Array.from(new Set(llm.split(/[,\s/|]+/).filter(Boolean))).slice(0, 5)
  // fallback if LLM gave nothing
  const out: string[] = []
  const v = Number(intent?.target_valence ?? 0.6)
  const e = Number(intent?.target_energy ?? 0.6)
  if (v >= 0.6) out.push('happy', 'bright', 'upbeat')
  else if (v <= 0.4) out.push('moody', 'melancholy', 'calm')
  if (e >= 0.65) out.push('energetic', 'morning')
  else if (e <= 0.4) out.push('chill', 'soft')
  return Array.from(new Set(out)).slice(0, 5)
}

export function normGenres(intent: any) {
  const raw = (intent?.genres || ['pop']).map((g: string) => g.toLowerCase().trim())
  const map: Record<string, string> = { hiphop: 'hip-hop', 'hip hop': 'hip-hop', rnb: 'r-n-b', 'r&b': 'r-n-b' }
  return Array.from(new Set(raw.map((g: string) => map[g] ?? g))).slice(0, 3)
}


/* ---------- recommendations-first (random from top 30) ---------- */
async function recommendationsPick(token: string, intent: any, markets = ['JP','US','GB','DE','KR']) {
  const seeds = shuffle((intent?.genres?.length ? intent.genres : ['pop']).slice(0,3))
  const market = sample(markets)

  const e = rangeAround(Number(intent?.target_energy ?? 0.6), 0.30)
  const v = rangeAround(Number(intent?.target_valence ?? 0.6), 0.30)
  const d = rangeAround(Number(intent?.target_danceability ?? 0.6), 0.30)
  const tempo = Math.round(Number(intent?.target_tempo ?? 118))
  const tMin = String(Math.max(60, tempo - 10))
  const tMax = String(Math.min(170, tempo + 10))

  const params = new URLSearchParams({
    market,
    limit: '50',
    seed_genres: seeds.join(','),
    min_energy: String(e.min), max_energy: String(e.max),
    min_valence: String(v.min), max_valence: String(v.max),
    min_danceability: String(d.min), max_danceability: String(d.max),
    min_tempo: tMin, max_tempo: tMax,
    min_popularity: '35',
  })

  const url = 'https://api.spotify.com/v1/recommendations?' + params.toString()
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) { console.error('recs_http', r.status, await r.text().catch(()=>'')); return null }
  const j = await r.json() as any
  const items: any[] = j?.tracks || []
  if (!items.length) return null

  // filter, take top slice, then random
  const filtered = items.filter(t => t && !t.explicit && t.duration_ms >= 120000 && t.duration_ms <= 420000)
  const pool = (filtered.length ? filtered : items).slice(0, 30)
  const pick = pool.length ? sample(pool) : null
  return pick ? {
    uri: pick.uri,
    url: pick.external_urls?.spotify || '',
    name: pick.name,
    artist: pick.artists?.map((a:any)=>a.name).join(', '),
  } : null
}

/* ---------- main: randomized selection everywhere ---------- */
export async function spotifyPickTrack(token: string, intent: any): Promise<PickedTrack> {
  // 1) Recommendations first
  const rec = await recommendationsPick(token, intent)
  if (rec) return rec

  // 2) Relaxed search (randomized)
  const genres = normGenres(intent)
  const mood = moodKeywords(intent)
  const queries: string[] = []
  if (genres.length && mood.length) {
    queries.push(`${genres.map(g => `genre:"${g}"`).join(' ')} ${mood.join(' ')} NOT live`)
    queries.push(`${genres.map(g => `genre:"${g}"`).join(' ')} ${mood.join(' ')}`)
  }
  if (mood.length) {
    queries.push(`${mood.join(' ')} NOT live`, `${mood.join(' ')}`)
  }
  queries.push(`"good morning"`, `"wake up"`)

  const markets = ['US','JP','GB','DE','KR']
  shuffle(queries); shuffle(markets)

  for (const q of queries) {
    for (const mkt of markets) {
      const pick = await searchOneTrack(token, q, mkt) // randomized inside
      if (pick) {
        console.log('pick_track', JSON.stringify({ q, market: mkt, name: pick.name, artist: pick.artist }))
        return pick
      }
    }
  }

  // 3) Playlist fallback (random playlist + random track)
  const firstGenre = genres[0] || 'pop'
  const firstMood = mood[0] || 'upbeat'
  const playlistQs = shuffle([
    'Good Morning', `${firstGenre} morning`, `${firstMood} morning`
  ])
  for (const pq of playlistQs) {
    for (const mkt of shuffle([...markets])) {
      const fromPl = await OneTrackFromOnePlaylist(token, pq, mkt) // randomized inside
      if (fromPl) {
        console.log('pick_from_playlist', JSON.stringify({ pq, market: mkt, name: fromPl.name, artist: fromPl.artist }))
        return fromPl
      }
    }
  }

  // 4) Hard fallback
  return {
    uri: 'spotify:track:11dFghVXANMlKmJXsNCbNl',
    url: 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl',
    name: 'Hard Fallback Track',
    artist: 'Spotify Example',
  }
}

/* ---------- randomized search fallback ---------- */
export async function searchOneTrack(token: string, q: string, market: string): Promise<PickedTrack | null> {
  const url = 'https://api.spotify.com/v1/search?' + new URLSearchParams({ q, type: 'track', market, limit: '20' }).toString()
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) { console.error('search_track_http', r.status, await r.text().catch(()=>'')); return null }
  const j = await r.json() as any
  const items: any[] = j?.tracks?.items || []
  if (!items.length) { console.log('search_empty', JSON.stringify({ q, market })); return null }

  items.sort((a,b) => (b.popularity||0) - (a.popularity||0))
  const filtered = items.filter(t => t && !t.explicit && t.duration_ms >= 120000 && t.duration_ms <= 420000)
  const pool = (filtered.length ? filtered : items).slice(0, 30) // ← top 30
  const pick = pool.length ? sample(pool) : null

  return pick ? {
    uri: pick.uri,
    url: pick.external_urls?.spotify || '',
    name: pick.name,
    artist: pick.artists?.map((a:any)=>a.name).join(', '),
  } : null
}

/* ---------- randomized playlist fallback ---------- */
export async function OneTrackFromOnePlaylist(token: string, query: string, market: string): Promise<PickedTrack | null> {
  const url = 'https://api.spotify.com/v1/search?' + new URLSearchParams({ q: query, type: 'playlist', market, limit: '5' }).toString()
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) { console.error('search_playlist_http', r.status, await r.text().catch(()=>'')); return null }
  const j = await r.json() as any
  const pls: any[] = j?.playlists?.items || []
  if (!pls.length) { console.log('no_playlist', JSON.stringify({ query, market })); return null }

  const pl: any = sample(pls) // ← random playlist among top results
  if (!pl?.id) return null

  const r2 = await fetch(`https://api.spotify.com/v1/playlists/${pl.id}/tracks?limit=50&market=${market}`, {
    headers: { authorization: `Bearer ${token}` }
  })
  if (!r2.ok) { console.error('playlist_tracks_http', r2.status, await r2.text().catch(()=>'')); return null }
  const j2 = await r2.json() as any
  const tracks: any[] = (j2?.items || []).map((x: any) => x.track).filter(Boolean)
  if (!tracks.length) { console.log('empty_playlist_tracks', JSON.stringify({ pl: pl.id, market })); return null }

  const clean = tracks.filter(t => !t?.explicit)
  const pick = (clean.length ? clean : tracks)[randInt(Math.min(30, (clean.length || tracks.length)))] // sample from first ~30
  return pick ? {
    uri: pick.uri,
    url: pick.external_urls?.spotify || '',
    name: pick.name,
    artist: pick.artists?.map((a:any)=>a.name).join(', '),
  } : null
}

// Playback control via Spotify Connect (Echo devices appear as devices when linked)
export async function spotifyPlayOnDevice(userToken: string, trackUri: string, preferredName?: string): Promise<PlaybackResult> {
  // 1) Get devices
  const r = await fetch('https://api.spotify.com/v1/me/player/devices', {
    headers: { authorization: `Bearer ${userToken}` },
  })
  if (!r.ok) throw new Error(`devices ${r.status}`)
  const j = (await r.json()) as any
  const devices: any[] = j?.devices || []
  if (!devices.length) throw new Error('no_devices')

  // 2) Choose target device
  let target = null as any
  const nameNorm = (s: any) => String(s || '').toLowerCase()
  const want = nameNorm(preferredName)

  if (want) target = devices.find((d) => nameNorm(d?.name) === want) || devices.find((d) => nameNorm(d?.name).includes(want))
  if (!target) target = devices.find((d) => /echo|alexa/i.test(String(d?.name)))
  if (!target) target = devices.find((d) => String(d?.type).toLowerCase() === 'speaker')
  if (!target) target = devices[0]
  if (!target?.id) throw new Error('no_target_device')

  // 3) Try to play directly on the device
  const playUrl = `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(target.id)}`
  const body = JSON.stringify({ uris: [trackUri] })
  let rPlay = await fetch(playUrl, {
    method: 'PUT',
    headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
    body,
  })
  if (rPlay.status === 404 || rPlay.status === 403) {
    // No active device; transfer and try again
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ device_ids: [target.id], play: true }),
    }).catch(() => {})
    rPlay = await fetch(playUrl, { method: 'PUT', headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' }, body })
  }

  if (!rPlay.ok && rPlay.status !== 204) {
    const txt = await rPlay.text().catch(() => '')
    throw new Error(`play ${rPlay.status} ${txt}`)
  }

  return { device: { id: target.id, name: target.name, type: target.type }, ok: true }
}
