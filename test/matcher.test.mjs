import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  embedding,
  cosine,
  labelScore,
  historyFactor,
  validateThresholds,
  scoreTemplate,
  thresholdDecision,
  selectTemplate,
} from '../src/matcher.js';

const template = (over = {}) => ({
  id: 't1',
  name: '并行调查',
  description: '拆成并行子任务后汇总',
  labels: ['investigation', 'parallel'],
  stats: { runs: 0, successes: 0 },
  ...over,
});

const query = { name: '并行调查', text: '拆成并行子任务后汇总', labels: ['investigation', 'parallel'] };

test('an identical template scores 1 and is reused', () => {
  const r = selectTemplate(query, [template()]);
  assert.equal(r.decision, 'reuse');
  assert.equal(r.best.score, 1);
});

test('an unrelated template falls below the ask band and creates', () => {
  const other = template({ id: 't2', name: '样式重写', description: '重写用户界面样式表', labels: ['css'] });
  const r = selectTemplate({ name: '数据库迁移', text: '迁移生产库结构', labels: ['db'] }, [other]);
  assert.equal(r.decision, 'create');
  assert.ok(r.best.score < 0.6, `expected < 0.6, got ${r.best.score}`);
});

test('an empty library short-circuits to create', () => {
  const r = selectTemplate(query, []);
  assert.deepEqual({ decision: r.decision, reason: r.reason, best: r.best }, { decision: 'create', reason: 'empty-library', best: null });
  assert.deepEqual(r.candidates, []);
});

test('threshold boundaries are inclusive at 0.8 and 0.6', () => {
  assert.equal(thresholdDecision(0.8), 'reuse');
  assert.equal(thresholdDecision(0.7999), 'ask');
  assert.equal(thresholdDecision(0.6), 'ask');
  assert.equal(thresholdDecision(0.5999), 'create');
});

test('thresholds are validated and inverted thresholds are rejected', () => {
  assert.throws(() => validateThresholds(0.5, 0.7), RangeError);
  assert.throws(() => validateThresholds(1.5, 0.6), RangeError);
  assert.throws(() => validateThresholds(Number.NaN, 0.6), TypeError);
  assert.throws(() => selectTemplate(query, [template()], { reuseThreshold: 0.4, askThreshold: 0.9 }), RangeError);
  assert.doesNotThrow(() => validateThresholds(0.8, 0.6));
});

test('history multiplies the base score without changing it', () => {
  const good = template({ id: 'good', stats: { runs: 10, successes: 10 } });
  const bad = template({ id: 'bad', stats: { runs: 10, successes: 0 } });
  const g = scoreTemplate(query, good);
  const b = scoreTemplate(query, bad);
  assert.equal(g.base, b.base);
  assert.equal(g.historyFactor, 1);
  assert.equal(b.historyFactor, 0.5);
  assert.ok(g.score > b.score);
  assert.equal(g.score, g.base);
});

test('a template with no history is scored neutrally, not zeroed', () => {
  assert.equal(historyFactor(undefined), 1);
  assert.equal(historyFactor({ runs: 0, successes: 0 }), 1);
  assert.equal(historyFactor({ runs: 4, successes: 2 }, 0.5), 0.75);
  assert.equal(historyFactor({ runs: 4, successes: 9 }, 0.5), 1);
});

test('scoring is deterministic for identical inputs', () => {
  const a = scoreTemplate(query, template());
  const b = scoreTemplate(query, template());
  assert.deepEqual(a, b);
});

test('low history drags a semantically perfect match out of the reuse band', () => {
  // Asserted on the SCORER, because `selectTemplate` now short-circuits an EXACT
  // name: a perfect base can only be produced by a query whose text matches the
  // template's exactly, which includes the name -- see the exact-name test below.
  const doubt = template({ stats: { runs: 10, successes: 2 } });
  const scored = scoreTemplate(query, doubt);
  assert.equal(scored.base, 1);
  assert.equal(scored.score, 0.6);
  assert.equal(thresholdDecision(scored.score), 'ask');
});

test('an exact name is a lookup, not a similarity question', () => {
  // Found live: `find {name: "sample-summary"}` scored that very entry 0.1209 and
  // advised "create", because the name reached the scorer only through a cosine over
  // the template's whole text. Naming a saved graph exactly is how you refer to it,
  // so it must come back as a hit.
  const doubt = template({ stats: { runs: 10, successes: 2 } });
  const exact = selectTemplate(query, [doubt]);
  assert.equal(exact.reason, 'exact-name');
  assert.equal(exact.decision, 'reuse', 'naming the entry IS the answer');
  assert.equal(exact.best.score, 1);
  assert.equal(exact.best.exactName, true);

  // A PARTIAL name must not short-circuit: it goes through the scored path.
  const partial = selectTemplate({ ...query, name: '并行' }, [doubt]);
  assert.notEqual(partial.reason, 'exact-name');
  assert.ok(partial.best.score < 1, 'a partial name is still a similarity question');
  // Surrounding whitespace does not defeat a lookup.
  assert.equal(selectTemplate({ name: '  并行调查  ' }, [template()]).reason, 'exact-name');
});

test('Chinese near-duplicates beat Chinese non-duplicates', () => {
  const q = { name: '并行调查缓存子系统' };
  const same = template({ id: 'same', name: '并行调查缓存子系统', description: '', labels: [] });
  const other = template({ id: 'other', name: '重写用户界面样式', description: '', labels: [] });
  const rel = cosine(embedding('并行调查缓存子系统'), embedding('并行调查缓存子系统'));
  const unrel = cosine(embedding('并行调查缓存子系统'), embedding('重写用户界面样式'));
  assert.equal(rel, 1);
  assert.ok(unrel < rel, `expected ${unrel} < ${rel}`);
  assert.ok(scoreTemplate(q, same).score > scoreTemplate(q, other).score);
});

test('tokenizer emits CJK characters and bigrams but drops single latin letters', () => {
  const t = tokenize('并行 cache a 调查');
  assert.ok(t.includes('并行'));
  assert.ok(t.includes('cache'));
  assert.ok(t.includes('调'));
  assert.ok(!t.includes('a'));
});

test('an injected embedding provider replaces the built-in one', () => {
  const embed = () => Float64Array.from([1, 0]);
  const s = scoreTemplate(query, template(), { embed, labelWeight: 0, embeddingWeight: 1 });
  assert.equal(s.embeddingScore, 1);
  assert.equal(s.score, 1);
});

test('label Jaccard is 0 when either side has no labels, and 1 when identical', () => {
  assert.equal(labelScore([], []), 0);
  assert.equal(labelScore(['a'], []), 0);
  assert.equal(labelScore(['A', ' b '], ['a', 'b']), 1);
  assert.equal(labelScore(['a', 'b'], ['b', 'c']), 1 / 3);
});

test('a zero total weight is rejected instead of producing NaN', () => {
  assert.throws(() => scoreTemplate(query, template(), { labelWeight: 0, embeddingWeight: 0 }), RangeError);
});

test('candidates come back sorted by descending score', () => {
  const lib = [
    template({ id: 'far', name: '无关主题', description: '完全不同的内容', labels: ['x'] }),
    template({ id: 'near', name: '并行调查', description: '拆成并行子任务后汇总', labels: ['investigation', 'parallel'] }),
    template({ id: 'mid', name: '并行调查', labels: ['investigation'] }),
  ];
  const r = selectTemplate(query, lib);
  assert.equal(r.candidates[0].id, 'near');
  for (let i = 1; i < r.candidates.length; i += 1) {
    assert.ok(r.candidates[i - 1].score >= r.candidates[i].score);
  }
});

test('a missing template id still scores without throwing', () => {
  const s = scoreTemplate(query, { name: '并行调查', labels: ['investigation', 'parallel'] });
  assert.equal(s.id, undefined);
  assert.ok(s.score > 0);
});
