/* GET /api/health — liveness check (no secrets exposed) */
export async function onRequest({ env }) {
  return new Response(
    JSON.stringify({ ok: true, sync_configured: !!(env.SYNC_TOKEN || '').trim() }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}
