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
   API, /v1beta/interactions). Free tier: 8 hours of YouTube video a day;
   paid: $0.75 per 1M input tokens, ~100 tokens per second of video at low
   resolution (≈ $0.27 per hour plus output). Figures from Google's docs,
   2026-10-03.

   WHY BACKGROUND MODE: Gemini has to fetch and process the video on Google's
   side, which for a long video (or a busy model) takes longer than the ~100 s
   Cloudflare allows any request to stay open — the 504/524 errors. So nothing
   here ever waits on Gemini:
     start  POST /interactions with background:true → returns an id at once
     poll   GET  /interactions/{id}                 → in_progress | completed | …
   Each call is a quick round trip; the client drives the loop and the waiting.
   Free-tier results are kept for 1 day, far longer than any poll needs. */
export const GEMINI_MODEL = 'gemini-3.8-flash';
/* With no request held open, a window's size is limited only by output length:
   15 minutes of speech is ~2,500 words, well inside max_output_tokens. */
export const GEMINI_WINDOW_SEC = 900;
const GEMINI_PRICE = { in: 0.75, out: 3.75 };   /* USD per 1M tokens, paid tier, until 2026-12-31 */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const START_BUDGET_MS = 30000;

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
  return { raw, j, msg: String(j?.error?.message || raw || `HTTP ${r.status}`).slice(0, 240) };
}

/* Google's own errors → errors the client can act on. "busy" and
   "rate_limited" mean wait and try again; "quota" means stop for today. */
function googleError(status, msg) {
  if (status === 401 || status === 403) return new StudyError('bad_api_key', 'Google rejected the Gemini API key', 502);
  if (status === 429) {
    return /per.?day|daily|quota/i.test(msg) && !/per.?minute/i.test(msg)
      ? new StudyError('quota', 'Gemini’s free daily allowance is used up — try again tomorrow, or use the bookmark or paste below', 429)
      : new StudyError('rate_limited', 'Gemini is rate-limiting requests — waiting a moment', 429);
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

/* Create an interaction. Creating is quick even in background mode, so a few
   retries for "busy" (and one switch of model) fit easily in the budget. */
async function createInteraction(env, body) {
  const t0 = Date.now();
  let model = GEMINI_MODEL, switched = false, lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const left = START_BUDGET_MS - (Date.now() - t0);
    if (left < 3000) break;
    let r;
    try {
      r = await fetch(`${GEMINI_BASE}/interactions`, {
        method: 'POST', headers: headers(env), signal: AbortSignal.timeout(Math.min(left, 20000)),
        body: JSON.stringify({ ...body, model }),
      });
    } catch (e) {
      lastErr = new StudyError('busy', `Couldn’t reach Gemini (${e?.name === 'TimeoutError' ? 'timed out' : e?.message || 'network error'})`, 503);
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
    await sleep(1500 * (attempt + 1));
  }
  throw lastErr || new StudyError('busy', 'Gemini is busy right now', 503);
}

/* GET a background job. Two things can trip Google's "Multiple
   authentication credentials received" (HTTP 400) here, even though the key
   is only sent once:
     • a redirect to a separately signed result URL, if followed with our key
       still attached — so redirects are followed by hand, without the key;
     • Google's newer "AQ." keys, which on some endpoints count as two
       credentials in one depending on how they're sent.
   So each way Google accepts a key is tried in turn (header, query
   parameter, bearer token) and the one that works is remembered. */
export const GEMINI_CODE_VERSION = 'gemini-bg-3';
const AUTH_STYLES = ['header', 'query', 'bearer'];
let _authStyle = null;   /* per isolate; re-learned after a cold start */
export let lastAuthNote = '';

function authed(url, env, style) {
  if (style === 'query') return { url: `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(env.GEMINI_API_KEY)}`, headers: {} };
  if (style === 'bearer') return { url, headers: { Authorization: `Bearer ${env.GEMINI_API_KEY}` } };
  return { url, headers: { 'x-goog-api-key': env.GEMINI_API_KEY } };
}

async function getInteraction(env, id, timeoutMs = 20000) {
  const base = `${GEMINI_BASE}/interactions/${id}`;
  const signal = AbortSignal.timeout(timeoutMs);
  const order = _authStyle ? [_authStyle, ...AUTH_STYLES.filter((x) => x !== _authStyle)] : AUTH_STYLES;
  const tried = [];
  let r = null;
  for (const style of order) {
    const { url, headers: h } = authed(base, env, style);
    r = await fetch(url, { headers: h, redirect: 'manual', signal });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) r = await fetch(new URL(loc, base).toString(), { signal });
    if (r.status === 400) {
      const peek = await r.clone().text().catch(() => '');
      if (/multiple authentication credentials/i.test(peek)) { tried.push(style); continue; }
    }
    _authStyle = style;
    lastAuthNote = tried.length ? `job checks use ${style} auth (${tried.join(', ')} rejected)` : '';
    return r;
  }
  lastAuthNote = `all of ${tried.join(', ')} were rejected as "multiple credentials"`;
  return r;
}

const idOf = (j) => String(j?.id || j?.name || '').replace(/^interactions\//, '');
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/* Interaction (completed) → transcript lines in VIDEO time. Gemini reports
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

/* Start transcribing one window of a video in the background. */
export async function geminiStart(env, videoId, start = 0, end = 0) {
  if (!env.GEMINI_API_KEY) throw new StudyError('not_configured', 'GEMINI_API_KEY is not set', 501);
  if (!YT_ID_RE.test(videoId || '')) throw new StudyError('bad_video', 'Not a YouTube video id');
  start = Math.max(0, Math.floor(Number(start) || 0));
  end = Math.max(0, Math.floor(Number(end) || 0));
  const clipped = end > start;
  const prompt = `Transcribe all speech in this video${clipped ? ' clip' : ''} verbatim, in the language spoken.
Return one entry per sentence or short phrase. "t" is when it starts, in seconds from the start of ${clipped ? 'this clip' : 'the video'}.
Do not summarise, translate, or describe visuals. If there is no speech, return an empty list.`;
  const { j, model } = await createInteraction(env, {
    background: true,
    input: [
      { type: 'text', text: prompt },
      {
        type: 'video',
        uri: `https://www.youtube.com/watch?v=${videoId}`,
        resolution: 'low',   /* transcription needs the audio, not detailed frames */
        ...(clipped ? { processing: { type: 'static', start_offset: start, end_offset: end } } : {}),
      },
    ],
    response_format: { type: 'text', mime_type: 'application/json', schema: GEMINI_SCHEMA },
    generation_config: { max_output_tokens: 32000 },
  });
  const id = idOf(j);
  if (!ID_RE.test(id)) throw new StudyError('gemini_failed', 'Gemini didn’t return a job id for the background request', 502);
  return { id, model, status: String(j?.status || 'in_progress') };
}

/* Check one background job. Never throws for "still working", "busy" or
   "rate limited" — those come back as status 'running' so the client keeps
   polling; real failures throw. */
export async function geminiPoll(env, id, start = 0, end = 0) {
  if (!env.GEMINI_API_KEY) throw new StudyError('not_configured', 'GEMINI_API_KEY is not set', 501);
  if (!ID_RE.test(String(id || ''))) throw new StudyError('bad_job', 'Not a Gemini job id');
  start = Math.max(0, Number(start) || 0);
  end = Math.max(0, Number(end) || 0);
  let r;
  try {
    r = await getInteraction(env, id);
  } catch {
    return { status: 'running' };   /* transient — try again on the next poll */
  }
  const { j, msg } = await readJson(r);
  if (!r.ok) {
    const err = googleError(r.status, msg);
    if (err.code === 'busy' || err.code === 'rate_limited') return { status: 'running' };
    if (r.status === 404) throw new StudyError('expired', 'That Gemini job has expired — start again', 410);
    throw err;
  }
  const status = String(j?.status || '');
  if (status === 'completed') {
    return { status: 'done', lines: linesFrom(j, start, end), usage: { ...geminiUsage(j), model: String(j?.model || GEMINI_MODEL) } };
  }
  /* Output cut short: the client retries the window in two halves. */
  if (status === 'incomplete') return { status: 'incomplete' };
  if (status === 'failed' || status === 'cancelled') {
    const why = String(j?.error?.message || j?.status_details || status).slice(0, 240);
    if (/private|unlisted|not (?:be )?accessible|unavailable/i.test(why)) throw new StudyError('unavailable', 'Gemini can only read public videos', 422);
    throw new StudyError('gemini_failed', `Gemini couldn’t transcribe this part (${why})`, 502);
  }
  return { status: 'running' };   /* queued | in_progress */
}

/* Background round trip with no video — proves endpoint, model, auth, job
   ids and response parsing all line up, without using video allowance. */
export async function geminiSelfTest(env) {
  let started;
  try {
    const { j, model } = await createInteraction(env, { background: true, input: [{ type: 'text', text: 'Reply with exactly: OK' }] });
    started = { id: idOf(j), model };
  } catch (e) { return `couldn’t start a job: ${e.message}`; }
  if (!ID_RE.test(started.id)) return 'started, but no job id came back';
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const r = await getInteraction(env, started.id).catch(() => null);
    if (!r) continue;
    const { j, msg } = await readJson(r);
    if (!r.ok) return `HTTP ${r.status} while checking the job: ${msg}${lastAuthNote ? ` (${lastAuthNote})` : ''}`;
    if (j?.status === 'completed') {
      const note = started.model !== GEMINI_MODEL ? ` (using ${started.model}; ${GEMINI_MODEL} was busy)` : '';
      const how = lastAuthNote ? ` · ${lastAuthNote}` : '';
      return geminiText(j).trim() ? `ok — background jobs work${note}${how}` : 'job finished, but no text found in the reply';
    }
    if (j?.status === 'failed' || j?.status === 'cancelled') return `job ${j.status}: ${String(j?.error?.message || '').slice(0, 160)}`;
  }
  return 'job started but still running after 18 s — Gemini is slow right now; transcripts will still work, just take longer';
}
