export function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

export async function fetchJSONWithRetry(
  url: string,
  init: RequestInit,
  { tries = 3, baseMs = 400 }: { tries?: number; baseMs?: number } = {}
) {
  let lastErr: any
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 8000)
      const r = await fetch(url, { ...init, signal: ctrl.signal })
      clearTimeout(to)
      const text = await r.text()
      if (!r.ok) {
        // retry only on 429/5xx
        if (r.status === 429 || (r.status >= 500 && r.status <= 599)) lastErr = new Error(`deepseek ${r.status} ${text}`)
        else throw new Error(`deepseek ${r.status} ${text}`)
      } else {
        return text ? JSON.parse(text) : {}
      }
    } catch (e) {
      lastErr = e
    }
    await new Promise((res) => setTimeout(res, baseMs * Math.pow(2, i)))
  }
  throw lastErr
}

