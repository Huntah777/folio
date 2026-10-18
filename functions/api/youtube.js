/* ============================================================
   Folio · /api/youtube?v=<id>
   ------------------------------------------------------------
   Title, channel and whether the owner allows embedding for a YouTube link,
   plus captions when YouTube hands them to a server (it usually doesn't — the
   client then offers the "Send to Folio" bookmark or a paste box; see
   functions/_lib/youtube.js). Same sync-token guard as the other routes.
   ============================================================ */

import { json, tokenOk } from '../_lib/auth.js';
import { youtubeInfo, YouTubeError } from '../_lib/youtube.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  try {
    return json(await youtubeInfo(new URL(request.url).searchParams.get('v')));
  } catch (e) {
    if (e instanceof YouTubeError) return json({ error: e.code, message: e.message }, e.status);
    console.error('youtube error:', e);
    return json({ error: 'internal', message: 'Internal server error' }, 500);
  }
}
