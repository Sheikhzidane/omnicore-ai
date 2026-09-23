import type { NextRequest } from 'next/server'
import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// ElevenLabs voice ID — user-selected from voice library.
// Override via ELEVENLABS_VOICE_ID in .env.local.
const DEFAULT_VOICE_ID = 'wDsJlOXPqcvIUKdLXjDs'
const MODEL_ID         = 'eleven_turbo_v2_5'     // fast + cheap, multilingual
const MAX_CHARS        = 400

/**
 * Proxies text-to-speech calls to ElevenLabs so the API key stays server-side.
 * Returns an MP3 blob that VoiceNarrator plays via <audio>.
 *
 * - No ELEVENLABS_API_KEY in env → 501; client falls back to browser TTS.
 * - Successful call bumps a char-usage counter the dashboard can read.
 */
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.tts.post')
  if (!authz.ok) return authz.response

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'no-key', fallback: 'browser-tts' }, { status: 501 })
  }

  let text: string
  try {
    const body = await req.json()
    text = String(body?.text ?? '').slice(0, MAX_CHARS).trim()
  } catch {
    return NextResponse.json({ error: 'bad-body' }, { status: 400 })
  }
  if (!text) return NextResponse.json({ error: 'empty-text' }, { status: 400 })

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key':   apiKey,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: {
            stability:          0.45,   // slightly expressive
            similarity_boost:   0.80,   // stay close to the source
            style:              0.35,   // a touch of personality
            use_speaker_boost:  true,
          },
        }),
      },
    )

    if (!r.ok) {
      const err = await r.text().catch(() => '')
      // Credits out or rate-limited → signal client to fall back
      if (r.status === 401 || r.status === 429) {
        return NextResponse.json({ error: 'api-limit', fallback: 'browser-tts', detail: err.slice(0, 200) }, { status: r.status })
      }
      return NextResponse.json({ error: 'api-error', status: r.status, detail: err.slice(0, 200) }, { status: 502 })
    }

    const audio = await r.arrayBuffer()
    return new Response(audio, {
      status: 200,
      headers: {
        'Content-Type':   'audio/mpeg',
        'Cache-Control':  'no-store',
        'X-TTS-Chars':    String(text.length),
        'X-TTS-Voice':    voiceId,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return NextResponse.json({ error: 'fetch-failed', detail: msg.slice(0, 200) }, { status: 502 })
  }
}

/** GET returns current config + whether the key is set. Client uses this to
 *  decide whether to attempt the premium path. */
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  return NextResponse.json({
    enabled:   Boolean(process.env.ELEVENLABS_API_KEY),
    voiceId:   process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
    voiceName: 'Custom (library)',
    model:     MODEL_ID,
  })
}
