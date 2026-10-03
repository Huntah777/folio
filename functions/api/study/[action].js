/* ============================================================
   Folio · Study — /api/study/:action
   ------------------------------------------------------------
   POST generate    live (one chunk per request, client-driven) or batch
   GET  jobs        batch jobs; polls Anthropic and finalises ended batches
   POST ack         mark imported batch jobs so other devices skip them
   POST check       type-the-answer marking (cardCheck)
   POST recall      blank-page recall feedback (blankRecall)
   POST mark        written exam marking (examMarking) + attempt record
   POST transcribe  raw audio segment → Whisper text + per-phrase timings
   GET  youtube     ?v=<id> → title/author/embeddable + captions if obtainable
   GET  ping        configuration check (?deep=1 makes tiny real calls)
   GET  usage       estimated spend over the last 30 days

   AI results never go into the synced state blob — the client PUTs the
   whole blob, so a server-side write there would be overwritten. They live
   in D1 `study_jobs`; the client imports them through its own update().

   Bindings: DB (D1), AI (Workers AI). Secrets: SYNC_TOKEN, ANTHROPIC_API_KEY.
   ============================================================ */

import Anthropic from '@anthropic-ai/sdk';
import { json, tokenOk } from '../../_lib/auth.js';
import { youtubeInfo, GEMINI_CODE_VERSION, geminiSelfTest, geminiTranscribeStream, geminiCost, GEMINI_WINDOW_SEC } from '../../_lib/youtube.js';
import {
  MODELS, KINDS, StudyError, WHISPER_MODEL,
  checkModel, checkSize, runLive, submitBatch, retrieveBatch, collectBatch, costOf, transcribe,
} from '../../_lib/ai.js';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;   /* one ~5 min segment at 32 kbps is ~1.2 MB */
const MAX_BODY_CHARS  = 2_000_000;
const JOB_ID_RE       = /^[A-Za-z0-9-]{8,48}$/;
const RETAIN_MS       = 35 * 24 * 60 * 60 * 1000;
const STALE_COLLECT_MS = 2 * 60 * 1000;

const now = () => Date.now();

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) throw new StudyError('too_large', 'Request too large', 413);
  try { return JSON.parse(raw); } catch { throw new StudyError('bad_json', 'Body must be JSON'); }
}

const str = (v, max = 20000) => String(v ?? '').slice(0, max);

/* Every call is logged (without bulky results for the chatty ones) so the
   usage endpoint can show what this feature actually costs. */
async function logCall(env, { id, setId = null, kinds, model, mode, status, meta = {}, result = null, usage = null, error = null, batchId = null }) {
  const t = now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO study_jobs
       (id, set_id, kinds, model, mode, batch_id, status, request_meta, result, error, usage, notified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).bind(
    id, setId, kinds, model, mode, batchId, status, JSON.stringify(meta),
    result == null ? null : JSON.stringify(result),
    error, usage == null ? null : JSON.stringify(usage), t, t,
  ).run();
}

/* ── generate ── */
async function generate(env, body) {
  const { jobId, setId = null, title = '', mode = 'live', items } = body || {};
  if (!JOB_ID_RE.test(jobId || '')) throw new StudyError('bad_job', 'jobId must be 8–48 letters, digits or dashes');
  if (!Array.isArray(items) || !items.length) throw new StudyError('bad_items', 'items is required');

  const clean = items.map((it) => {
    const kind = it?.kind;
    if (!KINDS[kind]?.generation) throw new StudyError('bad_kind', `Unknown generation kind: ${kind}`);
    checkModel(it.model, { batch: mode === 'batch' });
    const payload = {
      material: str(it.payload?.material, 1_500_000),
      existingFronts: (it.payload?.existingFronts || []).slice(0, 300).map((s) => str(s, 300)),
      options: it.payload?.options || {},
    };
    if (!payload.material.trim()) throw new StudyError('empty', 'Nothing to study — the selected notes are empty');
    checkSize(it.model, payload);
    /* Which notes this chunk covers — echoed back with batch results so the
       client can attach cards to the right note without re-deriving chunks. */
    const noteIds = (Array.isArray(it.noteIds) ? it.noteIds : []).slice(0, 500).map((id) => str(id, 64));
    return { kind, model: it.model, chunk: Number(it.chunk) || 0, payload, noteIds };
  });

  if (mode === 'batch') {
    const meta = clean.map((it) => ({ custom_id: `${it.kind}_${it.chunk}`, kind: it.kind, model: it.model, chunk: it.chunk, noteIds: it.noteIds }));
    if (new Set(meta.map((m) => m.custom_id)).size !== meta.length) throw new StudyError('bad_items', 'Duplicate kind/chunk pair');
    const existing = await env.DB.prepare('SELECT status FROM study_jobs WHERE id = ?').bind(jobId).first();
    if (existing) return { status: existing.status, jobId };   /* retried submit — don't pay twice */
    const batchId = await submitBatch(env, clean.map((it, i) => ({ ...it, custom_id: meta[i].custom_id })));
    await logCall(env, {
      id: jobId, setId, mode: 'batch', status: 'submitted', batchId,
      kinds: [...new Set(clean.map((c) => c.kind))].join(','),
      model: [...new Set(clean.map((c) => c.model))].join(','),
      meta: { title: str(title, 200), items: meta },
    });
    return { status: 'submitted', jobId };
  }

  if (clean.length !== 1) throw new StudyError('bad_items', 'Live generation takes one item per request');
  const it = clean[0];
  const rowId = `${jobId}:${it.kind}:${it.chunk}`;
  /* A retry after a dropped connection picks up the finished result instead
     of paying for the same generation twice. */
  const prev = await env.DB.prepare('SELECT status, result, usage FROM study_jobs WHERE id = ?').bind(rowId).first();
  if (prev?.status === 'done' && prev.result) {
    const usage = JSON.parse(prev.usage || 'null');
    return { status: 'done', result: JSON.parse(prev.result), usage, cost: usage ? costOf(usage) : 0, cached: true };
  }
  const { data, usage } = await runLive(env, it.kind, it.model, it.payload, { cache: !!body.cache });
  await logCall(env, {
    id: rowId, setId, kinds: it.kind, model: it.model, mode: 'live', status: 'done',
    meta: { title: str(title, 200), chunk: it.chunk }, result: data, usage,
  });
  return { status: 'done', result: data, usage, cost: costOf(usage) };
}

/* ── batch jobs ──
   Finalising is guarded by a conditional UPDATE so two devices polling at
   once can't both stream and store the same results. */
async function finaliseBatch(env, row) {
  const meta = JSON.parse(row.request_meta || '{}');
  const batch = await retrieveBatch(env, row.batch_id);
  if (batch.processing_status !== 'ended') {
    return { ...row, counts: batch.request_counts };
  }
  /* A 'collecting' row older than STALE_COLLECT_MS belongs to a request that
     died mid-way, so it may be claimed again. */
  const claimed = await env.DB.prepare(
    `UPDATE study_jobs SET status = 'collecting', updated_at = ?
      WHERE id = ? AND (status IN ('submitted','ended') OR (status = 'collecting' AND updated_at < ?))`,
  ).bind(now(), row.id, now() - STALE_COLLECT_MS).run();
  if (!claimed.meta?.changes) return null;   /* another request is collecting it */

  try {
    const items = await collectBatch(env, row.batch_id, meta.items || []);
    const usage = items.filter((i) => i.usage).reduce((u, i) => ({
      input: u.input + i.usage.input, output: u.output + i.usage.output,
      cacheRead: u.cacheRead + i.usage.cacheRead, cacheWrite: u.cacheWrite + i.usage.cacheWrite,
      byModel: { ...u.byModel, [i.model]: costOf(i.usage, { batch: true }) + (u.byModel[i.model] || 0) },
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {} });
    const anyOk = items.some((i) => i.ok);
    await env.DB.prepare(
      `UPDATE study_jobs SET status = ?, result = ?, usage = ?, error = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      anyOk ? 'done' : 'error',
      JSON.stringify({ items }),
      JSON.stringify(usage),
      anyOk ? null : (items[0]?.error || `Batch ${batch.processing_status} with no results`),
      now(), row.id,
    ).run();
  } catch (e) {
    /* Put it back so the next poll retries the collection. */
    await env.DB.prepare(`UPDATE study_jobs SET status = 'ended', updated_at = ? WHERE id = ?`).bind(now(), row.id).run();
    throw e;
  }
  return env.DB.prepare('SELECT * FROM study_jobs WHERE id = ?').bind(row.id).first();
}

const publicJob = (row) => {
  const meta = JSON.parse(row.request_meta || '{}');
  const usage = row.usage ? JSON.parse(row.usage) : null;
  return {
    id: row.id,
    setId: row.set_id,
    status: row.status,
    kinds: (row.kinds || '').split(',').filter(Boolean),
    title: meta.title || '',
    createdAt: row.created_at,
    counts: row.counts || null,
    error: row.error || null,
    cost: usage?.byModel ? Object.values(usage.byModel).reduce((a, b) => a + b, 0) : null,
    result: row.status === 'done' && row.result ? JSON.parse(row.result) : null,
  };
};

async function listJobs(env) {
  const rows = (await env.DB.prepare(
    `SELECT * FROM study_jobs
      WHERE mode = 'batch' AND status IN ('submitted','ended','collecting','done','error')
      ORDER BY created_at DESC LIMIT 30`,
  ).all()).results || [];

  const out = [];
  let polled = 0;
  for (const row of rows) {
    const stuck = row.status === 'collecting' && row.updated_at < now() - STALE_COLLECT_MS;
    if ((row.status === 'submitted' || row.status === 'ended' || stuck) && polled < 5) {
      polled++;
      try {
        const next = await finaliseBatch(env, row);
        if (next) { out.push(publicJob(next)); continue; }
      } catch (e) {
        console.error('batch poll failed', row.id, e.message);
      }
    }
    out.push(publicJob(row));
  }

  /* Opportunistic housekeeping — the push worker does this hourly too. */
  if (Math.random() < 0.05) {
    await env.DB.prepare(`DELETE FROM study_jobs WHERE created_at < ?`).bind(now() - RETAIN_MS).run();
  }
  return { jobs: out };
}

async function ack(env, body) {
  const ids = (body?.ids || []).filter((id) => JOB_ID_RE.test(id)).slice(0, 50);
  for (const id of ids) {
    /* Drop the stored result — it now lives in the synced state. */
    await env.DB.prepare(
      `UPDATE study_jobs SET status = 'imported', result = NULL, updated_at = ? WHERE id = ? AND mode = 'batch'`,
    ).bind(now(), id).run();
  }
  return { ok: true, acked: ids.length };
}

/* ── interactive calls ── */
async function check(env, body) {
  const model = body?.model;
  const payload = { question: str(body?.question, 2000), expected: str(body?.expected, 2000), answer: str(body?.answer, 4000) };
  if (!payload.answer.trim()) throw new StudyError('empty', 'No answer given');
  const { data, usage } = await runLive(env, 'cardCheck', model, payload);
  await logCall(env, { id: crypto.randomUUID(), kinds: 'cardCheck', model, mode: 'live', status: 'done', usage });
  return { result: data, cost: costOf(usage) };
}

async function recall(env, body) {
  const model = body?.model;
  const payload = { material: str(body?.material, 1_500_000), recall: str(body?.recall, 40000) };
  if (!payload.material.trim()) throw new StudyError('empty', 'This note is empty');
  if (!payload.recall.trim()) throw new StudyError('empty', 'Write what you remember first');
  const { data, usage } = await runLive(env, 'blankRecall', model, payload);
  await logCall(env, { id: crypto.randomUUID(), kinds: 'blankRecall', model, mode: 'live', status: 'done', usage, meta: { noteId: str(body?.noteId, 64) } });
  return { result: data, cost: costOf(usage) };
}

async function mark(env, body) {
  const model = body?.model;
  const questions = (body?.questions || []).slice(0, 40).map((q, i) => ({
    index: Number.isInteger(q.index) ? q.index : i,
    q: str(q.q, 4000),
    marks: Math.max(1, Math.min(50, Number(q.marks) || 1)),
    mark_scheme: (q.mark_scheme || []).slice(0, 30).map((s) => str(s, 1000)),
    model_answer: str(q.model_answer, 6000),
    answer: str(q.answer, 12000),
  }));
  if (!questions.length) throw new StudyError('empty', 'No written answers to mark');
  const { data, usage } = await runLive(env, 'examMarking', model, { questions });

  /* Clamp scores to each question's marks — the scheme is the ceiling. */
  const byIndex = new Map(questions.map((q) => [q.index, q]));
  data.results = data.results
    .filter((r) => byIndex.has(r.index))
    .map((r) => ({ ...r, max: byIndex.get(r.index).marks, score: Math.max(0, Math.min(byIndex.get(r.index).marks, r.score)) }));

  const attemptId = crypto.randomUUID();
  const score = data.results.reduce((s, r) => s + r.score, 0);
  const max = questions.reduce((s, q) => s + q.marks, 0);
  await env.DB.prepare(
    `INSERT INTO study_attempts (id, set_id, exam_id, data, score, max, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(attemptId, str(body?.setId, 64), str(body?.examId, 64), JSON.stringify({ questions, results: data.results }), score, max, now()).run();
  await logCall(env, { id: crypto.randomUUID(), setId: str(body?.setId, 64), kinds: 'examMarking', model, mode: 'live', status: 'done', usage });
  return { result: data, attemptId, cost: costOf(usage) };
}

async function doTranscribe(env, request) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('audio/')) throw new StudyError('bad_type', `Expected audio, got ${type || 'nothing'}`, 415);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_AUDIO_BYTES) throw new StudyError('too_large', 'Audio segment too large (max 10 MB)', 413);
  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength) throw new StudyError('empty', 'Empty audio segment');
  if (buffer.byteLength > MAX_AUDIO_BYTES) throw new StudyError('too_large', 'Audio segment too large (max 10 MB)', 413);
  let prompt = '';
  try { prompt = decodeURIComponent(request.headers.get('X-Prompt') || ''); } catch {}
  const language = /^[a-z]{2}$/.test(request.headers.get('X-Language') || '') ? request.headers.get('X-Language') : undefined;
  return transcribe(env, buffer, { prompt, language });
}

/* YouTube transcripts via Gemini (see _lib/youtube.js): one window per
   request, answered as a stream of heartbeats then the result, so Gemini can
   take minutes without Cloudflare's ~100 s cutoff applying. Usage is logged
   when a window completes; cost counts only when GEMINI_BILLING=paid. */
function ytStream(env, request, waitUntil) {
  const p = new URL(request.url).searchParams;
  const v = p.get('v');
  return geminiTranscribeStream(env, v, p.get('start'), p.get('end'), async (res) => {
    const cost = env.GEMINI_BILLING === 'paid' ? geminiCost(res.usage) : 0;
    try {
      await logCall(env, {
        id: crypto.randomUUID(), kinds: 'ytTranscript', model: res.usage.model, mode: 'live', status: 'done',
        usage: { ...res.usage, cacheRead: 0, cacheWrite: 0, byModel: { [res.usage.model]: cost } }, meta: { videoId: str(v, 20) },
      });
    } catch {}
    return { cost };
  }, waitUntil);
}

/* ── diagnostics ── */
async function ping(env, url) {
  const out = { anthropic: !!env.ANTHROPIC_API_KEY, gemini: !!env.GEMINI_API_KEY, workersAi: !!env.AI, db: !!env.DB, models: Object.keys(MODELS), whisper: WHISPER_MODEL };
  if (url.searchParams.get('deep') !== '1') return out;
  if (env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK.' }] });
      out.anthropicCall = 'ok';
    } catch (e) {
      out.anthropicCall = e instanceof Anthropic.AuthenticationError ? 'invalid API key'
        : e instanceof Anthropic.APIError ? `error ${e.status}` : (e.message || 'failed');
    }
  }
  if (env.GEMINI_API_KEY) {
    /* Listing models validates the key without spending any of the daily video allowance. */
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY }, signal: AbortSignal.timeout(8000) });
      out.geminiCall = r.ok ? 'key ok' : r.status === 400 || r.status === 401 || r.status === 403 ? 'invalid API key' : `error ${r.status}`;
      if (r.ok) out.geminiCall += ' · ' + await geminiSelfTest(env);
      out.geminiCall += ` · code ${GEMINI_CODE_VERSION}`;
    } catch (e) {
      out.geminiCall = e.message || 'failed';
    }
  }
  if (env.AI) {
    try {
      await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 });
      out.workersAiCall = 'ok';
    } catch (e) {
      out.workersAiCall = e.message || 'failed';
    }
  }
  return out;
}

/* Spend from logged token usage. Day buckets use the client's timezone offset
   (?tz=minutes, as from Date#getTimezoneOffset) so "this month" and the daily
   chart line up with the user's calendar, not UTC. Rows are kept 35 days, so
   month-to-date is always fully covered. */
async function usageSummary(env, url) {
  const tzMin = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0));
  const local = (ms) => new Date(ms - tzMin * 60000);   /* read with getUTC* */
  const t = now();
  const today = local(t);
  const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) + tzMin * 60000;
  const since = Math.min(t - 30 * 24 * 60 * 60 * 1000, monthStart);
  const rows = (await env.DB.prepare(
    `SELECT kinds, model, mode, usage, created_at FROM study_jobs WHERE created_at >= ? AND usage IS NOT NULL`,
  ).bind(since).all()).results || [];

  const byModel = {}, byKind = {}, daily = {};
  let total = 0, monthToDate = 0, calls = 0;
  const add = (row, model, kind, c) => {
    const in30 = row.created_at >= t - 30 * 24 * 60 * 60 * 1000;
    if (row.created_at >= monthStart) monthToDate += c;
    if (!in30) return;
    byModel[model] = (byModel[model] || 0) + c;
    byKind[kind] = (byKind[kind] || 0) + c;
    const d = local(row.created_at).toISOString().slice(0, 10);
    daily[d] = (daily[d] || 0) + c;
    total += c;
  };
  for (const r of rows) {
    const u = JSON.parse(r.usage);
    if (r.created_at >= t - 30 * 24 * 60 * 60 * 1000) calls++;
    if (u.byModel) {   /* batch rows carry their own per-model split */
      const kinds = (r.kinds || '').split(',');
      for (const [m, c] of Object.entries(u.byModel)) {
        /* A batch can mix kinds; attribute its cost evenly across them. */
        for (const k of kinds) add(r, m, k, c / kinds.length);
      }
      continue;
    }
    add(r, r.model, r.kinds, costOf(u, { batch: r.mode === 'batch' }));
  }
  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = today.getUTCDate();
  return {
    days: 30, calls, total, byModel, byKind, daily,
    monthToDate,
    /* Simple pace projection: month-to-date ÷ days elapsed × days in month. */
    projectedMonth: dayOfMonth ? monthToDate / dayOfMonth * daysInMonth : 0,
    dayOfMonth, daysInMonth,
  };
}

/* ── router ── */
const ROUTES = {
  generate:   { method: 'POST', run: (env, req) => readJson(req).then((b) => generate(env, b)) },
  jobs:       { method: 'GET',  run: (env) => listJobs(env) },
  ack:        { method: 'POST', run: (env, req) => readJson(req).then((b) => ack(env, b)) },
  check:      { method: 'POST', run: (env, req) => readJson(req).then((b) => check(env, b)) },
  recall:     { method: 'POST', run: (env, req) => readJson(req).then((b) => recall(env, b)) },
  mark:       { method: 'POST', run: (env, req) => readJson(req).then((b) => mark(env, b)) },
  transcribe: { method: 'POST', run: (env, req) => doTranscribe(env, req) },
  youtube:    { method: 'GET',  run: async (env, req) => ({
    ...(await youtubeInfo(new URL(req.url).searchParams.get('v'))),
    gemini: !!env.GEMINI_API_KEY, geminiWindow: GEMINI_WINDOW_SEC,
  }) },
  ping:       { method: 'GET',  run: (env, req) => ping(env, new URL(req.url)) },
  usage:      { method: 'GET',  run: (env, req) => usageSummary(env, new URL(req.url)) },
};

export async function onRequest({ request, env, params, waitUntil }) {
  const route = ROUTES[params.action];
  if (!route && params.action !== 'ytStream') return json({ error: 'not_found' }, 404);
  if (route && request.method !== route.method) return json({ error: 'method_not_allowed' }, 405);
  if (!await tokenOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.DB) return json({ error: 'not_configured', message: 'D1 binding (DB) is missing' }, 501);

  /* Streams its own response (heartbeats, then the result). */
  if (params.action === 'ytStream') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return ytStream(env, request, waitUntil);
  }

  try {
    return json(await route.run(env, request));
  } catch (e) {
    if (e instanceof StudyError) return json({ error: e.code, message: e.message }, e.status);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'bad_api_key', message: 'Anthropic rejected the API key' }, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate_limited', message: 'Rate limited — try again in a minute' }, 429);
    if (e instanceof Anthropic.BadRequestError) {
      console.error('anthropic 400', e.message);
      return json({ error: 'bad_request', message: e.message }, 502);
    }
    if (e instanceof Anthropic.APIError) return json({ error: `anthropic_${e.status}`, message: 'The AI service had a problem — try again' }, 502);
    console.error(`study/${params.action} error:`, e);
    return json({ error: 'internal', message: 'Internal server error' }, 500);
  }
}
