/* GET /api/health — liveness check (no binding details exposed) */
export async function onRequest() {
  return new Response(
    JSON.stringify({ ok: true }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}
