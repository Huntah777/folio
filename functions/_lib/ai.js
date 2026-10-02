/* ============================================================
   Folio · Study — model calls shared by functions/api/study/[action].js
   ------------------------------------------------------------
   Not a route (no onRequest export). Everything model-specific lives in
   MODELS so the request builders never branch on a model name.

   Claude:  @anthropic-ai/sdk, structured outputs, prompt caching only when a
            run sends 2+ requests to the same model (a lone request would pay
            the 1.25x cache write for nothing).
   Llama:   Workers AI JSON mode — not guaranteed to match the schema, so the
            result is validated and the call retried once.
   Whisper: Workers AI, base64 audio.
   ============================================================ */

import Anthropic from '@anthropic-ai/sdk';

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/* price: USD per million tokens. maxInputTokens is per request/chunk and
   deliberately below each context window, leaving room for the instructions
   and the output. */
export const MODELS = {
  'claude-haiku-4-5':  { provider: 'anthropic',  maxInputTokens: 100_000, effort: false, fallbacks: false, batch: true,  price: { in: 1, out: 5 } },
  'claude-sonnet-5-5': { provider: 'anthropic',  maxInputTokens: 300_000, effort: true,  fallbacks: true,  batch: true,  price: { in: 2, out: 10 } },
  'claude-opus-5-5':   { provider: 'anthropic',  maxInputTokens: 300_000, effort: true,  fallbacks: true,  batch: true,  price: { in: 4, out: 20 } },
  [LLAMA]:             { provider: 'workers-ai', maxInputTokens: 12_000,  effort: false, fallbacks: false, batch: false, price: { in: 0.293, out: 2.253 } },
};

export class StudyError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.code = code; this.status = status; }
}

/* ~3.5 characters per token for English prose — deliberately pessimistic so
   a chunk the client sized never trips the server-side check. */
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.5);

/* ── output schemas ──
   Structured outputs require additionalProperties:false and every property
   listed in `required`; min/max constraints aren't supported, so counts are
   steered from the prompt instead. "Absent" values use [] / -1 / ''. */
const S = {
  str: { type: 'string' },
  int: { type: 'integer' },
  num: { type: 'number' },
  strs: { type: 'array', items: { type: 'string' } },
  obj: (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }),
};
S.arr = (items) => ({ type: 'array', items });

const SCHEMAS = {
  flashcards: S.obj({ cards: S.arr(S.obj({ noteId: S.str, front: S.str, back: S.str })) }),
  quiz: S.obj({ questions: S.arr(S.obj({ noteId: S.str, q: S.str, options: S.strs, answer: S.int, why: S.str })) }),
  exam: S.obj({
    title: S.str,
    durationMin: S.int,
    questions: S.arr(S.obj({
      type: { type: 'string', enum: ['mcq', 'written'] },
      q: S.str, options: S.strs, answer: S.int, marks: S.int, model_answer: S.str, mark_scheme: S.strs,
    })),
  }),
  smartNotes: S.obj({ title: S.str, markdown: S.str }),
  cardCheck: S.obj({ verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'] }, feedback: S.str, missing: S.str }),
  blankRecall: S.obj({
    coverage: S.int, recalled: S.strs, missed: S.strs, misconceptions: S.strs,
    cards: S.arr(S.obj({ front: S.str, back: S.str })),
  }),
  examMarking: S.obj({
    results: S.arr(S.obj({ index: S.int, score: S.num, hit: S.strs, missed: S.strs, tip: S.str })),
  }),
};

/* One system prompt for every kind, so two kinds on the same model can share
   a cached prefix (the material block comes straight after it). */
const SYSTEM = `You are the study assistant inside Folio, a personal notes app. You turn the user's own study material into accurate study aids, and you mark their answers.

Rules:
- Use only facts stated in the material provided. Never add outside facts.
- Material may be a speech-to-text lecture transcript with mistakes; work around obvious transcription errors rather than repeating them.
- Write in UK English, concisely, for a student revising for exams.
- Respond with the JSON object requested and nothing else.`;

const list = (items) => items.map((s) => `- ${s}`).join('\n');

/* Per-kind task text, placed AFTER the material so the material block stays a
   reusable cache prefix. maxTokens includes any adaptive thinking on
   Sonnet/Opus, which counts against max_tokens. */
export const KINDS = {
  flashcards: {
    generation: true, maxTokens: 16000, effort: 'medium',
    task: ({ existingFronts = [] }) => `Create flashcards for active recall from the material above.

- One fact or idea per card.
- front: a specific question with one clear answer. Not yes/no, and not "what does the note say about…".
- back: the answer in at most 25 words.
- Cover every important definition, mechanism, cause and effect, formula, date, example and distinction. Roughly one card per 60–100 words of substantive material; skip filler, greetings and course admin.
- noteId: the id of the NOTE block the fact came from.${existingFronts.length ? `
- These cards already exist. Do not repeat or rephrase them:
${list(existingFronts.slice(0, 300))}` : ''}`,
  },

  quiz: {
    generation: true, maxTokens: 12000, effort: 'medium',
    task: ({ options = {} }) => `Write ${options.count ? `exactly ${options.count}` : 'between 5 and 15 (about one per 300 words of material)'} multiple-choice questions on the material above.

- Exactly 4 options each, one correct. Distractors must be plausible to someone who half-knows the topic.
- Test understanding, not trivia or wording.
- answer: zero-based index of the correct option. Vary the position of the correct option.
- why: one sentence explaining the correct answer, based on the material.
- noteId: the id of the NOTE block the question is about.`,
  },

  exam: {
    generation: true, maxTokens: 16000, effort: 'medium',
    task: ({ options = {} }) => {
      const mcq = Number.isInteger(options.mcq) ? options.mcq : 6;
      const written = Number.isInteger(options.written) ? options.written : 3;
      const duration = Number.isInteger(options.durationMin) ? options.durationMin : 30;
      return `Write a mock exam paper on the material above: ${mcq} multiple-choice questions followed by ${written} written questions.

Multiple-choice questions: type "mcq", exactly 4 options, answer = zero-based index of the correct option, marks = 1, model_answer = the correct option's text, mark_scheme = one line explaining why it is correct.
Written questions: type "written", options = [], answer = -1, marks between 2 and 8, model_answer = a full-mark answer, mark_scheme = the creditworthy points, one mark each, so the number of points equals marks.
Questions should test understanding and application, not just recall, and should cover the whole material.
title: a short paper title. durationMin: ${duration}.`;
    },
  },

  smartNotes: {
    generation: true, maxTokens: 16000, effort: 'medium',
    task: () => `Turn the material above (a lecture transcript or document) into clean study notes.

Markdown allowed: "# ", "## ", "### " headings, "- " bullets (one level only), "> " quotes, **bold**, *italic* and \`code\`. No tables, numbered lists or nested bullets.
Structure: a one-paragraph overview; then a section per topic with the key points, definitions in bold and worked examples; then "## Summary" with 5 bullets and "## Questions to revisit" with 3 bullets.
title: a short descriptive title for the notes.`,
  },

  cardCheck: {
    generation: false, maxTokens: 4000, effort: 'low',
    task: ({ question, expected, answer }) => `Question: ${question}
Expected answer: ${expected}
Student's answer: ${answer}

Judge whether the student's answer shows they know the expected answer. Ignore spelling, word order and phrasing; synonyms and equivalent wording count.
verdict: "correct" if it captures the essential point, "partial" if it is on the right track but incomplete or vague, "incorrect" otherwise.
feedback: one short sentence to the student.
missing: what they left out, or "" if nothing.`,
  },

  blankRecall: {
    generation: false, maxTokens: 8000, effort: 'medium',
    task: ({ recall }) => `<recall>
${recall}
</recall>

The student wrote everything they could remember about the material above without looking at it. Compare their recall against the material.
coverage: 0–100, the share of the material's key ideas they recalled correctly.
recalled: the key ideas they got, as short phrases.
missed: key ideas absent from their recall, as short phrases.
misconceptions: statements in their recall that contradict the material ([] if none).
cards: one flashcard per missed idea or misconception (front: a specific question; back: the answer in at most 25 words).`,
  },

  examMarking: {
    generation: false, maxTokens: 8000, effort: 'medium',
    task: ({ questions }) => `Mark the student's written exam answers strictly against each mark scheme.

${questions.map((q) => `<question index="${q.index}" marks="${q.marks}">
${q.q}
Mark scheme:
${list(q.mark_scheme || [])}
Model answer: ${q.model_answer || ''}
Student's answer: ${q.answer?.trim() ? q.answer : '(no answer)'}
</question>`).join('\n\n')}

For each question return: index (as given), score (0 to marks; half marks allowed), hit (mark-scheme points credited), missed (points not credited), tip (one sentence on how to gain the missing marks).
Credit equivalent wording. Do not award marks for points that are not in the mark scheme unless they are clearly equivalent.`,
  },
};

/* ── validation ──
   Structured outputs guarantee the shape for Claude; Llama's JSON mode does
   not. One validator for both: coerces where harmless, drops unknown keys,
   throws on anything structurally wrong. */
function validate(schema, value, path = '$') {
  const fail = (why) => { throw new StudyError('model_output', `Model output invalid at ${path}: ${why}`, 502); };
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
      const out = {};
      for (const k of schema.required) {
        if (!(k in value)) fail(`missing ${k}`);
        out[k] = validate(schema.properties[k], value[k], `${path}.${k}`);
      }
      return out;
    }
    case 'array':
      if (!Array.isArray(value)) fail('expected array');
      return value.map((v, i) => validate(schema.items, v, `${path}[${i}]`));
    case 'string': {
      if (value == null) value = '';
      if (typeof value !== 'string') value = String(value);
      if (schema.enum && !schema.enum.includes(value)) fail(`expected one of ${schema.enum.join('|')}`);
      return value;
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) fail('expected number');
      return schema.type === 'integer' ? Math.round(n) : n;
    }
    default:
      return value;
  }
}

/* Semantic clean-up the schema can't express: drop malformed items instead
   of failing a whole 60-card run over one bad question. */
function tidy(kind, data) {
  if (kind === 'flashcards') {
    data.cards = data.cards.filter((c) => c.front.trim() && c.back.trim());
  } else if (kind === 'quiz') {
    data.questions = data.questions.filter((q) =>
      q.q.trim() && q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length);
  } else if (kind === 'exam') {
    data.questions = data.questions.filter((q) => q.q.trim() && (q.type === 'written'
      ? q.marks > 0
      : q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length));
    if (!(data.durationMin > 0)) data.durationMin = 30;
  } else if (kind === 'blankRecall') {
    data.coverage = Math.max(0, Math.min(100, data.coverage));
  }
  return data;
}

/* ── Claude ── */
const userContent = (kind, payload, cache) => {
  const content = [];
  if (payload.material) {
    content.push({
      type: 'text',
      text: `<material>\n${payload.material}\n</material>`,
      ...(cache ? { cache_control: { type: 'ephemeral' } } : {}),
    });
  }
  content.push({ type: 'text', text: KINDS[kind].task(payload) });
  return content;
};

export function buildClaudeParams(kind, model, payload, { cache = false } = {}) {
  const m = MODELS[model], k = KINDS[kind];
  const params = {
    model,
    max_tokens: k.maxTokens,
    system: SYSTEM,
    messages: [{ role: 'user', content: userContent(kind, payload, cache) }],
    output_config: { format: { type: 'json_schema', schema: SCHEMAS[kind] } },
  };
  /* Haiku 4.5 rejects effort; Opus 5.5 defaults to medium, so always set it. */
  if (m.effort) params.output_config.effort = k.effort;
  return params;
}

const anthropic = (env) => {
  if (!env.ANTHROPIC_API_KEY) throw new StudyError('not_configured', 'ANTHROPIC_API_KEY is not set', 501);
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
};

const usageOf = (u = {}) => ({
  input: u.input_tokens || 0,
  output: u.output_tokens || 0,
  cacheRead: u.cache_read_input_tokens || 0,
  cacheWrite: u.cache_creation_input_tokens || 0,
});

/* stop_reason first, then the text block — Sonnet/Opus responses lead with
   (empty) thinking blocks, so content[0] is not the answer. */
export function parseClaudeMessage(kind, msg) {
  if (msg.stop_reason === 'refusal') {
    throw new StudyError('refused', 'The model declined this request', 422);
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new StudyError('too_long', 'The answer was cut off — try a smaller set of notes', 422);
  }
  const text = (msg.content || []).find((b) => b.type === 'text')?.text;
  if (!text) throw new StudyError('model_output', 'The model returned no text', 502);
  let raw;
  try { raw = JSON.parse(text); } catch { throw new StudyError('model_output', 'The model returned invalid JSON', 502); }
  return { data: tidy(kind, validate(SCHEMAS[kind], raw)), usage: { ...usageOf(msg.usage), model: msg.model } };
}

async function runClaude(env, kind, model, payload, opts) {
  const client = anthropic(env);
  const params = buildClaudeParams(kind, model, payload, opts);
  /* Server-side fallback reroutes a declined request inside the same call.
     Live Sonnet/Opus only — the Batches API rejects the parameter. */
  const msg = MODELS[model].fallbacks
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  return parseClaudeMessage(kind, msg);
}

/* ── Llama (Workers AI) ── */
async function runLlama(env, kind, payload) {
  if (!env.AI) throw new StudyError('not_configured', 'Workers AI binding (AI) is not set', 501);
  const user = [
    payload.material ? `<material>\n${payload.material}\n</material>` : '',
    KINDS[kind].task(payload),
  ].filter(Boolean).join('\n\n');
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await env.AI.run(LLAMA, {
        messages: [
          { role: 'system', content: `${SYSTEM}\n\nThe JSON must match this schema: ${JSON.stringify(SCHEMAS[kind])}` },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: SCHEMAS[kind] },
        /* Workers AI defaults to 256 output tokens — far too few for a card set. */
        max_tokens: Math.min(KINDS[kind].maxTokens, 6000),
      });
      let raw = out?.response;
      if (typeof raw === 'string') raw = JSON.parse(raw);
      const data = tidy(kind, validate(SCHEMAS[kind], raw));
      return {
        data,
        usage: { input: out?.usage?.prompt_tokens || 0, output: out?.usage?.completion_tokens || 0, cacheRead: 0, cacheWrite: 0, model: LLAMA },
      };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr instanceof StudyError) throw lastErr;
  throw new StudyError('model_output', `Llama could not produce valid output: ${lastErr?.message || 'unknown error'}`, 502);
}

/* ── public entry points ── */
export function checkModel(model, { batch = false } = {}) {
  const m = MODELS[model];
  if (!m) throw new StudyError('bad_model', `Unknown model: ${model}`);
  if (batch && !m.batch) throw new StudyError('bad_model', `${model} does not support batch`);
  return m;
}

export function checkSize(model, payload) {
  const tokens = estimateTokens(payload.material) + estimateTokens(payload.recall) +
    estimateTokens(JSON.stringify(payload.questions || '')) + estimateTokens(JSON.stringify(payload.existingFronts || ''));
  if (tokens > MODELS[model].maxInputTokens * 1.1) {
    throw new StudyError('too_large', `Input is about ${tokens} tokens; ${model} takes up to ${MODELS[model].maxInputTokens} per request`, 413);
  }
}

export async function runLive(env, kind, model, payload, opts = {}) {
  checkModel(model);
  checkSize(model, payload);
  return MODELS[model].provider === 'anthropic'
    ? runClaude(env, kind, model, payload, opts)
    : runLlama(env, kind, payload);
}

/* items: [{ custom_id, kind, model, payload }] → Anthropic batch id.
   Caching inside a batch is best-effort, so it's only requested when 2+
   requests in the batch share both a model and its material. */
export async function submitBatch(env, items) {
  const client = anthropic(env);
  const shared = new Map();
  for (const it of items) {
    const key = `${it.model}\u0000${it.payload.material || ''}`;
    shared.set(key, (shared.get(key) || 0) + 1);
  }
  const batch = await client.messages.batches.create({
    requests: items.map((it) => ({
      custom_id: it.custom_id,
      params: buildClaudeParams(it.kind, it.model, it.payload, {
        cache: shared.get(`${it.model}\u0000${it.payload.material || ''}`) > 1,
      }),
    })),
  });
  return batch.id;
}

export async function retrieveBatch(env, batchId) {
  return anthropic(env).messages.batches.retrieve(batchId);
}

/* Results arrive in any order — keyed by custom_id, never position. */
export async function collectBatch(env, batchId, itemsMeta) {
  const client = anthropic(env);
  const byId = new Map(itemsMeta.map((m) => [m.custom_id, m]));
  const out = [];
  for await (const r of await client.messages.batches.results(batchId)) {
    const meta = byId.get(r.custom_id);
    if (!meta) continue;
    if (r.result.type === 'succeeded') {
      try {
        const { data, usage } = parseClaudeMessage(meta.kind, r.result.message);
        out.push({ ...meta, ok: true, data, usage });
      } catch (e) {
        out.push({ ...meta, ok: false, error: e.message });
      }
    } else {
      const why = r.result.type === 'errored' ? (r.result.error?.error?.message || 'errored') : r.result.type;
      out.push({ ...meta, ok: false, error: why });
    }
  }
  return out;
}

/* ── cost (USD) ── batch is billed at half price. */
export function costOf(usage, { batch = false } = {}) {
  /* The API may echo a dated snapshot id, so match on prefix. */
  const id = Object.keys(MODELS).find((m) => usage?.model === m || usage?.model?.startsWith(m));
  const price = id && MODELS[id].price;
  if (!price) return 0;
  const usd = (usage.input * price.in + usage.output * price.out +
    usage.cacheRead * price.in * 0.1 + usage.cacheWrite * price.in * 1.25) / 1e6;
  return batch ? usd / 2 : usd;
}

/* ── Whisper ──
   Workers has no Buffer without nodejs_compat, so base64 is built in chunks
   (String.fromCharCode on a 1 MB array would blow the argument limit). */
function toBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export async function transcribe(env, buffer, { prompt = '', language } = {}) {
  if (!env.AI) throw new StudyError('not_configured', 'Workers AI binding (AI) is not set', 501);
  const out = await env.AI.run(WHISPER_MODEL, {
    audio: toBase64(new Uint8Array(buffer)),
    vad_filter: true,
    ...(prompt ? { initial_prompt: prompt.slice(-500) } : {}),
    ...(language ? { language } : {}),
  });
  /* Per-phrase timings (seconds from the start of THIS audio chunk) let the
     client build a timestamped transcript that can seek the recording. Mapped
     defensively: if the model omits them the client falls back to the text. */
  const segments = (Array.isArray(out?.segments) ? out.segments : [])
    .map((sg) => ({ start: Number(sg?.start) || 0, end: Number(sg?.end) || 0, text: String(sg?.text || '').trim() }))
    .filter((sg) => sg.text);
  return {
    text: String(out?.text || '').trim(),
    duration: out?.transcription_info?.duration || 0,
    segments,
  };
}
