import type { Env, Req, Intent } from './types'
import { fetchJSONWithRetry } from './utils/http'

export function defaultIntent(): Intent {
  return { mood: 'default', genres: ["jazz"], target_energy: 0.6, target_valence: 0.6, target_danceability: 0.6, target_tempo: 118 }
}

export function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

export function sanitizeIntent(x: any): Intent {
  const ALLOWED = new Set([
    'pop',
    'rock',
    'indie',
    'jazz',
    'r-n-b',
    'classical',
    'folk',
    'soul',
    'ambient',
    'dance',
    'electronic',
    'country',
    'blues',
  ])
  const MAP: Record<string, string> = { hiphop: 'hip-hop', 'hip hop': 'hip-hop', rnb: 'r-n-b', 'r&b': 'r-n-b' }
  const g = (Array.isArray(x?.genres) ? x.genres : ['jazz'])
    .map((s: any) => String(s).toLowerCase().trim())
    .map((s: string) => MAP[s] ?? s)
    .filter((s: string) => ALLOWED.has(s))
  return {
    mood: typeof x?.mood === 'string' ? x.mood : 'default',
    genres: g.length ? g.slice(0, 3) : ['jazz'],
    target_energy: clamp01(Number.isFinite(x?.target_energy) ? x.target_energy : 0.6),
    target_valence: clamp01(Number.isFinite(x?.target_valence) ? x.target_valence : 0.6),
    target_danceability: clamp01(Number.isFinite(x?.target_danceability) ? x.target_danceability : 0.6),
    target_tempo: Math.max(60, Math.min(170, Math.round(Number(x?.target_tempo ?? 118)))),
  }
}

export function ruleBasedIntent(body: Req): Intent {
  const cond = (body.condition || '').toLowerCase()
  const t = Number(body.temperature ?? 18)
  const isWeekend = ['sat', 'sun'].includes(String(body.weekday || '').slice(0, 3).toLowerCase())
  let genres = ['jazz']
  let energy = 0.6,
    valence = 0.6,
    dance = 0.6,
    tempo = 118

  if (cond.includes('rain') || cond.includes('drizzle')) {
    genres = ['indie', 'jazz']
    energy = 0.55
    valence = 0.45
    tempo = 100
  } else if (cond.includes('snow')) {
    genres = ['ambient', 'classical']
    energy = 0.5
    valence = 0.4
    tempo = 95
  } else if (cond.includes('cloud') || cond.includes('overcast') || cond.includes('mist') || cond.includes('fog')) {
    genres = ['indie', 'folk']
    energy = 0.55
    valence = 0.5
    tempo = 105
  } else if (cond.includes('clear') || cond.includes('sun')) {
    genres = ['pop', 'dance']
    energy = 0.7
    valence = 0.7
    tempo = 120
  }
  if (t >= 25) {
    energy += 0.05
    valence += 0.05
    tempo += 5
  }
  if (t <= 5) {
    energy -= 0.05
    valence -= 0.05
    tempo -= 5
  }
  if (isWeekend) energy = clamp01(energy + 0.05)

  return sanitizeIntent({
    genres,
    target_energy: energy,
    target_valence: valence,
    target_danceability: dance,
    target_tempo: tempo,
  })
}

export async function mapWeatherToIntent(body: Req, env: Env): Promise<Intent> {
  const sys = `Return strict JSON with keys:
mood (a mood based on weather, time, temperature, and condition),
genres (1-3 from: pop, rock, indie, jazz, r-n-b, classical, folk, soul, ambient, dance, electronic, country, blues),
target_energy (0..1), target_valence (0..1), target_danceability (0..1), target_tempo (60..170).
Output ONLY valid JSON.`

  const user = `condition=${body.condition}; temp=${body.temperature ?? 'NA'}C; time=${body.time ?? '08:00'}; weekday=${body.weekday ?? ''}.
  The weather condition is described as: ${body.condition}. The time of day is: ${body.time}.
  Based on these inputs, generate a suitable mood. The mood can be upbeat, mellow, energetic, calm, sad, or any descriptive word fitting the condition.`

  try {
    // If no API key is configured, skip the network call and use rules
    if (!env.DEEPSEEK_API_KEY) {
      const intent = ruleBasedIntent(body)
      console.log('intent_source', 'ruleBased_no_key', JSON.stringify(intent))
      return intent
    }
    const j = await fetchJSONWithRetry('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner', // or "deepseek-reasoner"
        temperature: 0.8,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
      }),
    })

    const raw = j?.choices?.[0]?.message?.content
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const intent = sanitizeIntent(parsed)
    console.log('intent_source', 'deepseek', JSON.stringify(intent))
    return intent
  } catch (e: any) {
    console.error('deepseek_failure', String(e))
    const intent = ruleBasedIntent(body)  // fallback to the rule-based system
    console.log('intent_source', 'ruleBased', JSON.stringify(intent))
    return intent
  }
}
