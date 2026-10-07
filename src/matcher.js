/**
 * D4 semantic template matching (increment: the plugin gives name lookup, this
 * adds scoring). Reuses the existing template library; it does not store one.
 *
 * score = base * historyFactor
 *   base          = (labelWeight * labelJaccard + embeddingWeight * cosine) / (labelWeight + embeddingWeight)
 *   historyFactor = historyFloor + (1 - historyFloor) * successRate, or 1 when the template has no history
 *
 * The default embedding is a deterministic hashed bag-of-words so the layer has
 * no network or model dependency; inject `embed` to use a real provider.
 */

const DIM = 256;
const CJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/;

export function tokenize(text) {
  const raw = String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const out = [];
  for (const token of raw) {
    if (CJK.test(token)) {
      for (const ch of token) out.push(ch);
      for (let i = 0; i + 1 < token.length; i += 1) out.push(token.slice(i, i + 2));
    } else if (token.length > 1) {
      out.push(token);
    }
  }
  return out;
}

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function embedding(text, dim = DIM) {
  const v = new Float64Array(dim);
  const tokens = tokenize(text);
  if (tokens.length === 0) return v;
  for (const token of tokens) v[fnv1a(token) % dim] += 1;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i += 1) v[i] /= norm;
  return v;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

function normLabel(label) {
  return String(label ?? '').trim().toLowerCase();
}

/** Jaccard over label sets. No labels on either side means no evidence, i.e. 0. */
export function labelScore(a = [], b = []) {
  const setA = new Set((a ?? []).map(normLabel).filter(Boolean));
  const setB = new Set((b ?? []).map(normLabel).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

export function historyFactor(stats, floor = 0.5) {
  const runs = Number(stats?.runs ?? 0);
  const successes = Number(stats?.successes ?? 0);
  if (!Number.isFinite(runs) || runs <= 0) return 1;
  const rate = Number.isFinite(successes) ? Math.max(0, Math.min(1, successes / runs)) : 0;
  return floor + (1 - floor) * rate;
}

export function validateThresholds(reuseThreshold = 0.8, askThreshold = 0.6) {
  if (typeof reuseThreshold !== 'number' || typeof askThreshold !== 'number' || !Number.isFinite(reuseThreshold) || !Number.isFinite(askThreshold)) {
    throw new TypeError('thresholds must be finite numbers');
  }
  if (askThreshold < 0 || reuseThreshold > 1 || askThreshold > reuseThreshold) {
    throw new RangeError(`require 0 <= askThreshold <= reuseThreshold <= 1, got ask=${askThreshold} reuse=${reuseThreshold}`);
  }
}

export function scoreTemplate(query, template, options = {}) {
  const { labelWeight = 0.5, embeddingWeight = 0.5, historyFloor = 0.5, embed = embedding } = options;
  const weightSum = labelWeight + embeddingWeight;
  if (!(weightSum > 0)) throw new RangeError('labelWeight + embeddingWeight must be > 0');

  const queryText = [query?.name, query?.text, ...(query?.labels ?? [])].filter(Boolean).join(' ');
  const templateText = [template?.name, template?.description, ...(template?.labels ?? [])].filter(Boolean).join(' ');

  const label = labelScore(query?.labels, template?.labels);
  const embedScore = cosine(embed(queryText), embed(templateText));
  const factor = historyFactor(template?.stats, historyFloor);
  const base = (labelWeight * label + embeddingWeight * embedScore) / weightSum;

  return {
    id: template?.id,
    labelScore: label,
    embeddingScore: embedScore,
    historyFactor: factor,
    base,
    score: base * factor,
  };
}

export function thresholdDecision(score, options = {}) {
  const { reuseThreshold = 0.8, askThreshold = 0.6 } = options;
  validateThresholds(reuseThreshold, askThreshold);
  if (score >= reuseThreshold) return 'reuse';
  if (score >= askThreshold) return 'ask';
  return 'create';
}

/** @returns {{decision: 'reuse'|'ask'|'create', reason: string, best: object|null, candidates: object[]}} */
/**
 * A text query equal to a saved name is a name lookup written as free text.
 *
 * Measured live twice: the same words scored 1.0000 as `{name}` and 0.0000 as `{text}`,
 * and the `report` action scored EVERY row 0.0000 for a query that `find` answered with a
 * perfect hit -- the same words, two tools, opposite results. `selectTemplate` promotes
 * inline (verified working); `report` now promotes through this function.
 */
export function promoteNameQuery(query, library = []) {
  const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (norm(query?.name ?? '') !== '') return query;
  const asked = norm(query?.text ?? query?.task ?? '');
  if (asked === '') return query;
  const list = Array.isArray(library) ? library : [];
  const named = list.find((row) => norm(row?.name ?? row?.id) === asked);
  return named ? { ...query, name: named.name ?? named.id } : query;
}

export function selectTemplate(query, library = [], options = {}) {
  const { reuseThreshold = 0.8, askThreshold = 0.6 } = options;
  validateThresholds(reuseThreshold, askThreshold);
  const list = Array.isArray(library) ? library : [];

  // A query whose TEXT is exactly a saved graph's name is a name lookup written as free
  // text. Measured live on this machine: the SAME words scored 1.0000 as `{name}` and
  // 0.0000 as `{text}`, because CJK task prose barely overlaps a short summary. Promoting
  // it here lets the exact-name path below handle it -- one code path, not two.
  {
    const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const asked = norm(query?.name ?? query?.text ?? query?.task);
    if (norm(query?.name ?? '') === '' && asked !== '') {
      const named = list.find((row) => norm(row?.name ?? row?.id) === asked);
      if (named) query = { ...query, name: named.name ?? named.id };
    }
  }

  // An exact NAME is an identifier, not a similarity question.
  //
  // Measured live: `find {name: "sample-summary"}` scored that very entry 0.1209 and
  // advised "create", because the name reached the scorer only through a cosine over
  // the template's whole text, and its long description diluted a perfect hit. That
  // makes "look up the graph I already saved" the least reliable way to find it,
  // which is backwards. Naming an entry exactly returns it, and says why.
  const wanted = typeof query?.name === 'string' ? query.name.trim().toLowerCase() : '';
  if (wanted !== '') {
    const exact = list.find((t) => String(t?.name ?? t?.id ?? '').trim().toLowerCase() === wanted);
    if (exact) {
      const hit = { ...scoreTemplate(query, exact, options), id: exact.id ?? exact.name, score: 1, exactName: true };
      return { decision: 'reuse', reason: 'exact-name', best: hit, candidates: [hit] };
    }
  }

  const scored = list
    .map((t) => scoreTemplate(query, t, options))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  if (scored.length === 0) {
    return { decision: 'create', reason: 'empty-library', best: null, candidates: [] };
  }
  const best = scored[0];
  return {
    decision: thresholdDecision(best.score, options),
    reason: `best-score=${best.score.toFixed(4)}`,
    best,
    candidates: scored.slice(0, 5),
  };
}
