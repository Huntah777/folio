/* ============================================================
   Folio · Study — YouTube metadata and (best-effort) captions
   ------------------------------------------------------------
   Not a route. Used by functions/api/study/[action].js.

   • Title/author come from oEmbed — a public, documented endpoint that works
     from servers, and also tells us whether the owner allows embedding.
   • Captions are fetched from the same data the watch page itself uses. That
     is NOT an official API: YouTube blocks many datacenter IPs (Cloudflare's
     included), changes the format without notice, and may require tokens it
     doesn't hand to servers. So every failure is a typed reason the client can
     turn into "paste the transcript instead" — never an exception, and never
     a hard dependency.

   Tested 2026-10-02: the watch page and caption-track list load fine, but the
   caption download itself returns 200 with an empty body even from a
   residential connection — YouTube now wants a proof-of-origin token that only
   a real player has. So in practice this returns reason 'blocked' and the UI
   falls back to paste. It's kept because it still yields the title, channel
   and embeddability, costs nothing, and starts working again if the rules loosen.
   ============================================================ */

import { StudyError } from './ai.js';

export const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_LINES = 20000;
const TIMEOUT_MS = 6000;   /* a blocked request shouldn't hold up the paste fallback */
const get = (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });

/* Reads a balanced {...} object that starts right after `marker`, honouring
   strings and escapes — a regex can't, because captions metadata contains
   braces inside strings. */
export function extractJsonObject(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at + marker.length);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/* Prefer a human-made English track, then auto-generated English, then
   whatever exists first. */
export function pickTrack(tracks) {
  const en = (t) => /^en(-|$)/i.test(t.languageCode || '');
  return tracks.find((t) => en(t) && t.kind !== 'asr')
    || tracks.find((t) => en(t))
    || tracks.find((t) => t.kind !== 'asr')
    || tracks[0];
}

/* json3 → [{ t: seconds, text }]. Auto-captions arrive as overlapping
   rolling fragments, so empty/newline-only events are dropped and consecutive
   duplicates collapsed. */
export function parseJson3(data) {
  const lines = [];
  for (const ev of Array.isArray(data?.events) ? data.events : []) {
    if (!Array.isArray(ev.segs)) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (lines.length && lines[lines.length - 1].text === text) continue;
    lines.push({ t: Math.max(0, Math.round((Number(ev.tStartMs) || 0) / 100) / 10), text });
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

const hostOk = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === 'youtube.com' || h.endsWith('.youtube.com');
  } catch { return false; }
};

export async function youtubeInfo(videoId) {
  if (!YT_ID_RE.test(videoId || '')) throw new StudyError('bad_video', 'That doesn’t look like a YouTube video link');
  const out = { videoId, title: '', author: '', embeddable: true, transcript: null, language: null, reason: null, duration: 0 };

  /* 1. oEmbed: metadata + embeddability. */
  try {
    const r = await get(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { 'User-Agent': UA },
    );
    if (r.ok) {
      const j = await r.json();
      out.title = String(j.title || '');
      out.author = String(j.author_name || '');
    } else if (r.status === 401) {
      out.embeddable = false;          /* owner disabled embedding */
    } else if (r.status === 404) {
      out.reason = 'unavailable';      /* deleted or private */
      return out;
    }
  } catch { /* metadata is a nicety; carry on */ }

  /* 2. Captions, best effort. */
  try {
    const page = await get(`https://www.youtube.com/watch?v=${videoId}&hl=en`,
      { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' });
    const html = await page.text();
    const player = extractJsonObject(html, 'ytInitialPlayerResponse');
    if (!player) { out.reason = 'blocked'; return out; }
    if (!out.title) out.title = String(player.videoDetails?.title || '');
    if (!out.author) out.author = String(player.videoDetails?.author || '');
    out.duration = Number(player.videoDetails?.lengthSeconds) || 0;   /* sizes the Gemini windows */
    const status = player.playabilityStatus?.status;
    if (status && status !== 'OK') {
      out.reason = status === 'LOGIN_REQUIRED' ? 'blocked' : 'unavailable';
      return out;
    }
    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length) { out.reason = 'no_captions'; return out; }
    const track = pickTrack(tracks);
    if (!track?.baseUrl || !hostOk(track.baseUrl)) { out.reason = 'failed'; return out; }

    const u = new URL(track.baseUrl);
    u.searchParams.set('fmt', 'json3');
    const cap = await get(u.toString(), { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' });
    const body = cap.ok ? await cap.text() : '';
    if (!body.trim()) { out.reason = 'blocked'; return out; }   /* typical datacenter response: 200 + empty */
    let json;
    try { json = JSON.parse(body); } catch { out.reason = 'failed'; return out; }
    const lines = parseJson3(json);
    if (!lines.length) { out.reason = 'no_captions'; return out; }
    out.transcript = lines;
    out.language = track.languageCode || null;
  } catch {
    out.reason = 'failed';
  }
  return out;
}

/* ── Gemini: the sanctioned way to get a transcript from a YouTube link ──
   Google's Gemini API accepts a public YouTube URL directly (Interactions
   API, /v1beta/interactions). The free tier allows 8 hours of YouTube video a
   day; paid is $0.75 per million input tokens and a second of video at low
   resolution is ~100 tokens (≈ $0.27 per hour, plus output) — figures from
   Google's docs and pricing page, 2026-10-03.
   One request covers one time window; the client asks for the windows one by
   one, so no single request runs long and progress can be shown. Timings come
   back relative to the window and are shifted to video time here. */
export const GEMINI_MODEL = 'gemini-3.8-flash';
/* Cloudflare cuts a request off at ~100 s (HTTP 524), and Gemini needs
   roughly 20-40 s per 10 minutes of video — so windows stay small. */
export const GEMINI_WINDOW_SEC = 600;
const GEMINI_PRICE = { in: 0.75, out: 3.75 };   /* USD per 1M tokens, paid tier, until 2026-12-31 */

const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { t: { type: 'number' }, text: { type: 'string' } },
        required: ['t', 'text'],
      },
    },
  },
  required: ['lines'],
};

/* The response format has varied between API revisions; look everywhere the
   text has been documented to live rather than trusting one path. */
export function geminiText(j) {
  if (typeof j?.output_text === 'string') return j.output_text;
  const texts = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v.type === 'text' && typeof v.text === 'string') texts.push(v.text);
    else if (typeof v.text === 'string' && !v.type) texts.push(v.text);
    for (const k of ['steps', 'outputs', 'output', 'content', 'candidates', 'parts']) if (k in v) walk(v[k]);
  };
  walk(j);
  return texts.join('');
}

function geminiUsage(j) {
  const u = j?.usage || j?.usage_metadata || j?.usageMetadata || {};
  return {
    input: Number(u.total_input_tokens ?? u.input_tokens ?? u.promptTokenCount ?? u.prompt_token_count) || 0,
    output: Number(u.total_output_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? u.candidates_token_count) || 0,
  };
}

export const geminiCost = ({ input = 0, output = 0 } = {}) =>
  (input * GEMINI_PRICE.in + output * GEMINI_PRICE.out) / 1e6;

export async function geminiTranscript(env, videoId, start = 0, end = 0) {
  if (!env.GEMINI_API_KEY) throw new StudyError('not_configured', 'GEMINI_API_KEY is not set', 501);
  if (!YT_ID_RE.test(videoId || '')) throw new StudyError('bad_video', 'Not a YouTube video id');
  start = Math.max(0, Math.floor(Number(start) || 0));
  end = Math.max(0, Math.floor(Number(end) || 0));
  const clipped = end > start;
  const video = {
    type: 'video',
    uri: `https://www.youtube.com/watch?v=${videoId}`,
    resolution: 'low',   /* transcription needs the audio, not detailed frames */
    ...(clipped ? { processing: { type: 'static', start_offset: start, end_offset: end } } : {}),
  };
  const prompt = `Transcribe all speech in this video${clipped ? ' clip' : ''} verbatim, in the language spoken.
Return one entry per sentence or short phrase. "t" is when it starts, in seconds from the start of ${clipped ? 'this clip' : 'the video'}.
Do not summarise, translate, or describe visuals. If there is no speech, return an empty list.`;

  let r;
  try {
    r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    signal: AbortSignal.timeout(85000),   /* answer cleanly before Cloudflare's own cutoff */
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [{ type: 'text', text: prompt }, video],
      response_format: { type: 'text', mime_type: 'application/json', schema: GEMINI_SCHEMA },
      generation_config: { max_output_tokens: 32000 },
    }),
  });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new StudyError('timeout', 'Gemini took too long on this part', 504);
    throw new StudyError('gemini_failed', `Couldn’t reach Gemini: ${e?.message || 'network error'}`, 502);
  }
  const raw = await r.text();
  let j = null;
  try { j = JSON.parse(raw); } catch {}
  if (!r.ok) {
    const msg = j?.error?.message || raw.slice(0, 200) || `HTTP ${r.status}`;
    if (r.status === 429) throw new StudyError('quota', 'Gemini’s free daily allowance is used up — try again tomorrow, or use the bookmark or paste below', 429);
    if (r.status === 401 || r.status === 403) throw new StudyError('bad_api_key', 'Google rejected the Gemini API key', 502);
    if (/private|unlisted|not (?:be )?accessible|unavailable/i.test(msg)) {
      throw new StudyError('unavailable', 'Gemini can only read public videos', 422);
    }
    throw new StudyError('gemini_failed', `Gemini couldn’t transcribe this: ${msg}`, 502);
  }

  const text = geminiText(j).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let data;
  try { data = JSON.parse(text); } catch { throw new StudyError('gemini_failed', 'Gemini returned an unreadable transcript', 502); }
  const lines = (Array.isArray(data?.lines) ? data.lines : [])
    .map((l) => ({ t: Math.round((start + Math.max(0, Number(l?.t) || 0)) * 10) / 10, text: String(l?.text || '').replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text && (!clipped || l.t <= end + 5))
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_LINES);
  return { lines, usage: { ...geminiUsage(j), model: GEMINI_MODEL } };
}
