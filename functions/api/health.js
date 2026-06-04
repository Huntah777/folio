/* GET /api/health — returns binding status (no auth needed) */
export async function onRequest({ env }) {
  return new Response(
    JSON.stringify({
      db_bound:    !!env.DB,
      token_bound: !!env.SYNC_TOKEN,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
