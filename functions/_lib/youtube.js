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
  const out = { videoId, title: '', author: '', embeddable: true, transcript: null, language: null, reason: null };

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
