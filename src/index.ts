import type { Env, Req } from './types'
import { json } from './utils/http'
import { mapWeatherToIntent } from './intent'
import { spotifyPickTrack, spotifyPlayOnDevice, spotifyToken, spotifyUserToken } from './spotify'

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      if (req.method !== 'POST') return new Response('POST only', { status: 405 })
      const body = (await req.json().catch(() => ({}))) as Req & { play?: boolean; device?: string }
      if (!body?.condition) return json({ fallback: true, reason: 'missing_condition' })

      // 1) Map weather to target intent via LLM or rule-based fallback
      const intent = await mapWeatherToIntent(body, env).catch((e) => {
        console.error('openai_error', e)
        return null
      })

      // 2) Spotify token
      const token = await spotifyToken(env).catch((e) => {
        console.error('spotify_token_error', e)
        return null
      })

      if (!intent || !token) {
        return json({ fallback: true, reason: 'upstream_unavailable' })
      }

      // 3) Spotify recommendations
      const rec = await spotifyPickTrack(token, intent).catch((e) => (console.error('spotify_pick_error', e), null))
      if (!rec) return json({ fallback: true, reason: 'no_recommendation', intent })

      // 4) If configured, start playback on Echo/Alexa via Spotify Connect
      const shouldPlay = Boolean(body?.play) || Boolean(env.SPOTIFY_DEVICE_NAME) || Boolean(env.SPOTIFY_REFRESH_TOKEN)
      if (shouldPlay && env.SPOTIFY_REFRESH_TOKEN && env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET) {
        try {
          const userToken = await spotifyUserToken(env)
          const targetName = (body?.device || env.SPOTIFY_DEVICE_NAME || '').trim()
          const played = await spotifyPlayOnDevice(userToken, rec.uri, targetName)
          return json({ ...rec, played })
        } catch (e: any) {
          console.error('playback_error', e?.message || e)
          return json({ ...rec, played: false, playback_error: String(e?.message || e) })
        }
      }

      return json(rec)
    } catch (e: any) {
      console.error('fatal', e?.stack || e)
      return json({ fallback: true, reason: 'fatal' })
    }
  },
}

