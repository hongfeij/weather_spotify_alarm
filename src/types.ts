export interface Env {
  OPENAI_API_KEY: string
  SPOTIFY_CLIENT_ID: string
  SPOTIFY_CLIENT_SECRET: string
  // A long-lived refresh token for your Spotify user (with user-modify-playback-state scope)
  SPOTIFY_REFRESH_TOKEN?: string
  // Optional default target device name (e.g., "Office Echo Dot")
  SPOTIFY_DEVICE_NAME?: string
  // Using DeepSeek above; keep typing flexible
  DEEPSEEK_API_KEY?: string
}

export type Req = {
  location?: string
  condition: string
  temperature?: number
  weekday?: string
  time?: string
}

export type Intent = {
  mood: string
  genres: string[]
  target_energy: number
  target_valence: number
  target_danceability: number
  target_tempo: number
}

export type PickedTrack = {
  uri: string
  url: string
  name: string
  artist: string
}

export type PlaybackResult = {
  device: { id: string; name: string; type: string }
  ok: boolean
}
