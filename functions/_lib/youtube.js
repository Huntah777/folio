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
   API, POST /v1beta/interactions). Free tier: 8 hours of YouTube video a day;
   paid: $0.75 per 1M input tokens, ~100 tokens per second of video at low
   resolution (≈ $0.27 per hour plus output). Figures from Google's docs,
   2026-10-03.

   HOW LONG WAITS ARE HANDLED: Gemini fetches and processes the video on
   Google's side, which can take minutes. Cloudflare cuts off a request that
   hasn't started answering within ~100 s (HTTP 524), so the transcribe
   endpoint (geminiTranscribeStream, used by /api/study/ytStream) answers at
   once and streams newline-delimited JSON: a heartbeat every 10 s while
   Gemini works, then the result. Nothing ever sits silent long enough to be
   cut off, and only the ordinary POST is used.
   (Background mode — start a job, poll it — was tried first: Google rejects
   the poll with API-key auth, wanting an OAuth token instead.) */
export const GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_CODE_VERSION = 'gemini-filter-6';
/* 15 minutes of speech is ~2,500 words, well inside max_output_tokens, and
   keeps each Gemini call to a few minutes. */
export const GEMINI_WINDOW_SEC = 900;
const GEMINI_PRICE = { in: 0.75, out: 3.75 };   /* USD per 1M tokens, paid tier, until 2026-12-31 */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const headers = (env) => ({ 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY });

async function readJson(r) {
  const raw = await r.text();
  let j = null;
  try { j = JSON.parse(raw); } catch {}
  /* Google sometimes wraps its error object in a one-element array. */
  const err = Array.isArray(j) ? j[0]?.error : j?.error;
  return { raw, j, msg: String(err?.message || raw || `HTTP ${r.status}`).slice(0, 240) };
}

/* Google's own errors → errors the client can act on. "busy" and
   "rate_limited" mean wait and try again; "quota" means stop for today. */
function googleError(status, msg) {
  if (status === 401 || status === 403 || /api key not valid|invalid api key|API_KEY_INVALID/i.test(msg)) {
    return new StudyError('bad_api_key', 'Google rejected the Gemini API key — check GEMINI_API_KEY', 502);
  }
  if (status === 429) {
    return /per.?day|daily|quota/i.test(msg) && !/per.?minute/i.test(msg)
      ? new StudyError('quota', 'Gemini’s free daily allowance is used up — try again tomorrow, or use the bookmark or paste below', 429)
      : new StudyError('rate_limited', 'Gemini is rate-limiting requests — waiting a moment', 429);
  }
  if (status === 400 && /input blocked|blocked by gemini|gemini'?s filters|safety/i.test(msg)) {
    return new StudyError('filtered', 'Gemini’s content filter blocked this part (it misfires on technical videos)', 422);
  }
  if (status === 503 || status === 500) return new StudyError('busy', `Gemini is busy right now (${msg})`, 503);
  if (/private|unlisted|not (?:be )?accessible|unavailable/i.test(msg)) return new StudyError('unavailable', 'Gemini can only read public videos', 422);
  return new StudyError('gemini_failed', `Gemini couldn’t transcribe this (Google said HTTP ${status}: ${msg})`, 502);
}

/* Newest plain "gemini-<n>-flash" the key can use, other than `current` —
   for when the default model keeps answering "high demand". */
async function pickFallbackModel(env, current) {
  try {
    const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: headers(env), signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const names = ((await r.json()).models || []).map((m) => String(m.name || '').replace(/^models\//, ''));
    return names
      .map((n) => ({ n, v: (n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/) || [])[1] }))
      .filter((x) => x.v && x.n !== current)
      .sort((a, b) => Number(b.v) - Number(a.v))[0]?.n || null;
  } catch { return null; }
}

/* POST an interaction. "Busy" (503/500) is retried with a growing pause and,
   after two failures, with the newest other plain Flash model. budgetMs caps
   the whole thing; attemptMs caps one call (a video transcription can
   legitimately take minutes). */
async function createInteraction(env, body, { budgetMs = 30000, attemptMs = 20000 } = {}) {
  const t0 = Date.now();
  let model = GEMINI_MODEL, switched = false, lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const left = budgetMs - (Date.now() - t0);
    if (left < 3000) break;
    let r;
    try {
      r = await fetch(`${GEMINI_BASE}/interactions`, {
        method: 'POST', headers: headers(env), signal: AbortSignal.timeout(Math.min(left, attemptMs)),
        body: JSON.stringify({ ...body, model }),
      });
    } catch (e) {
      lastErr = e?.name === 'TimeoutError'
        ? new StudyError('timeout', 'Gemini took too long on this part', 504)
        : new StudyError('busy', `Couldn’t reach Gemini (${e?.message || 'network error'})`, 503);
      if (lastErr.code === 'timeout') throw lastErr;
      continue;
    }
    const { j, msg } = await readJson(r);
    if (r.ok) return { j, model };
    lastErr = googleError(r.status, msg);
    if (lastErr.code !== 'busy') throw lastErr;
    if (attempt >= 1 && !switched) {
      switched = true;
      const alt = await pickFallbackModel(env, model);
      if (alt) { model = alt; continue; }
    }
    await sleep(Math.min(3000 * (attempt + 1), Math.max(0, budgetMs - (Date.now() - t0) - 3000)));
  }
  throw lastErr || new StudyError('busy', 'Gemini is busy right now', 503);
}

/* Completed interaction → transcript lines in VIDEO time. Gemini reports
   times relative to the clip, so `start` is added back. */
function linesFrom(j, start, end) {
  const text = geminiText(j).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let data;
  try { data = JSON.parse(text); }
  catch { throw new StudyError('gemini_failed', `Gemini answered, but not in a readable form. Reply began: ${text.slice(0, 160).replace(/\s+/g, ' ')}`, 502); }
  return (Array.isArray(data?.lines) ? data.lines : [])
    .map((l) => ({ t: Math.round((start + Math.max(0, Number(l?.t) || 0)) * 10) / 10, text: String(l?.text || '').replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text && (!(end > start) || l.t <= end + 5))
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_LINES);
}

/* Transcribe one window of a video (this can take minutes). */
export async function geminiTranscribe(env, videoId, start = 0, end = 0) {
  if (!env.GEMINI_API_KEY) throw new StudyError('not_configured', 'GEMINI_API_KEY is not set', 501);
  if (!YT_ID_RE.test(videoId || '')) throw new StudyError('bad_video', 'Not a YouTube video id');
  start = Math.max(0, Math.floor(Number(start) || 0));
  end = Math.max(0, Math.floor(Number(end) || 0));
  const clipped = end > start;
  const what = clipped ? 'this clip' : 'this video';
  /* Google's input filter misfires on technical lectures (coding, cloud,
     security — its own error message says so) and suggests rephrasing, so
     there are differently worded fallbacks. */
  const prompts = [
    `Transcribe all speech in ${what} verbatim, in the language spoken.
Return one entry per sentence or short phrase. "t" is when it starts, in seconds from the start of ${what}.
Do not summarise, translate, or describe visuals. If there is no speech, return an empty list.`,
    `${clipped ? 'This clip is part of' : 'This is'} a public educational lecture. Write closed captions for the presenter's narration in ${what}, as timed lines.
"t" is when each line starts, in seconds from the start of ${what}. Captions only — no commentary.`,
    `Caption ${what}. One line per sentence; "t" = seconds from the start of ${what}.`,
  ];
  /* The API reference gives the offsets as duration strings ("1200s") while
     the video guide shows plain numbers — try the reference form first and
     the other only if Google rejects the clip itself. */
  const clips = clipped
    ? [{ type: 'static', start_offset: `${start}s`, end_offset: `${end}s` }, { type: 'static', start_offset: start, end_offset: end }]
    : [null];
  const t0 = Date.now();
  let c = 0, p = 0;
  for (;;) {
    try {
      const { j, model } = await createInteraction(env, {
        input: [
          { type: 'text', text: prompts[p] },
          {
            type: 'video',
            uri: `https://www.youtube.com/watch?v=${videoId}`,
            resolution: 'low',   /* transcription needs the audio, not detailed frames */
            ...(clips[c] ? { processing: clips[c] } : {}),
          },
        ],
        response_format: { type: 'text', mime_type: 'application/json', schema: GEMINI_SCHEMA },
        generation_config: { max_output_tokens: 32000 },
      }, { budgetMs: 9 * 60 * 1000 - (Date.now() - t0), attemptMs: 7 * 60 * 1000 });
      return { lines: linesFrom(j, start, end), usage: { ...geminiUsage(j), model: String(j?.model || model) } };
    } catch (e) {
      if (clipped && isClipRejection(e)) {
        if (++c < clips.length) continue;
        throw new StudyError('clip_unsupported', `Gemini won’t take part of this video (${e.message})`, 422);
      }
      if (e.code === 'filtered' && ++p < prompts.length) continue;
      throw e;
    }
  }
}

/* A 400 that names the clip settings — Google refusing the request shape,
   not the video. */
function isClipRejection(e) {
  return e?.code === 'gemini_failed' && /HTTP 400/.test(e.message) && /processing|offset/i.test(e.message);
}

/* The streaming wrapper the endpoint returns: answers immediately, sends
   {"type":"ping","s":<seconds>} every 10 s, then one final
   {"type":"done",…} or {"type":"error",…} line. `onDone` runs before the
   final line (usage logging). */
export function geminiTranscribeStream(env, videoId, start, end, onDone, waitUntil) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (o) => writer.write(enc.encode(JSON.stringify(o) + '\n')).catch(() => {});
  const t0 = Date.now();
  const work = (async () => {
    await send({ type: 'ping', s: 0 });
    const beat = setInterval(() => send({ type: 'ping', s: Math.round((Date.now() - t0) / 1000) }), 10000);
    try {
      const res = await geminiTranscribe(env, videoId, start, end);
      const extra = (await onDone?.(res)) || {};
      await send({ type: 'done', lines: res.lines, model: res.usage.model, ...extra });
    } catch (e) {
      await send({ type: 'error', code: e?.code || 'internal', status: e?.status || 500, message: e?.message || 'Transcription failed' });
    } finally {
      clearInterval(beat);
      await writer.close().catch(() => {});
    }
  })();
  waitUntil?.(work);
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/* Tiny real request with no video — proves endpoint, model, auth and
   response parsing line up, without using any video allowance. */
export async function geminiSelfTest(env) {
  try {
    const { j, model } = await createInteraction(env, { input: [{ type: 'text', text: 'Reply with exactly: OK' }] }, { budgetMs: 25000, attemptMs: 20000 });
    const note = model !== GEMINI_MODEL ? ` (using ${model}; ${GEMINI_MODEL} was busy)` : '';
    return geminiText(j).trim() ? `ok — Gemini answers${note}` : 'Gemini answered, but no text was found in the reply';
  } catch (e) {
    return `request failed: ${e.message}`;
  }
}
