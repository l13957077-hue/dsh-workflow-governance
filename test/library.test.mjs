import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTemplateLibrary } from '../src/library.js';

function withLib(fn, { now } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wfg-lib-'));
  try {
    return fn(createTemplateLibrary({ root, now }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const stringOut = { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } }, additionalProperties: false };
const graph = () => ({
  nodes: [{ id: 'collect', prompt: 'collect' }, { id: 'synthesize', prompt: 'synthesize' }],
  edges: [{ from: 'collect', to: 'synthesize', when: stringOut }],
});

test('an empty library lists nothing and has no file on disk until the first save', () => {
  withLib((lib, root) => {
    assert.deepEqual(lib.list(), []);
    assert.equal(lib.has('nope'), false);
    assert.equal(existsSync(join(root, 'library.json')), false, 'no file is created just by listing');
  });
});

test('save creates a revision-1 entry and persists it', () => {
  withLib((lib, root) => {
    const r = lib.save({ name: 'investigate', description: 'fan out', labels: ['research'], ...graph() });
    assert.equal(r.ok, true);
    assert.equal(r.code, 'CREATED');
    assert.equal(r.entry.revision, 1);
    assert.equal(r.entry.nodes, 2);
    assert.equal(r.entry.edges, 1);
    assert.ok(existsSync(join(root, 'library.json')));
    assert.equal(lib.list().length, 1);
  });
});

test('re-saving the same name bumps the revision and keeps createdAt', () => {
  let clock = 1000;
  withLib((lib) => {
    const first = lib.save({ name: 'x', ...graph() });
    assert.equal(first.entry.createdAt, 1000);
    assert.equal(first.entry.updatedAt, 1000);
    clock = 2000;
    const second = lib.save({ name: 'x', ...graph() });
    assert.equal(second.code, 'REPLACED');
    assert.equal(second.entry.revision, 2);
    assert.equal(second.entry.createdAt, 1000, 'createdAt is preserved across replace');
    assert.equal(second.entry.updatedAt, 2000, 'now() drives updatedAt');
    assert.equal(lib.list().length, 1, 'replace does not duplicate');
  }, { now: () => clock });
});

test('FAIL CLOSED: a graph with an unenforceable contract cannot be saved', () => {
  withLib((lib) => {
    const r = lib.save({
      name: 'bad',
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ from: 'a', to: 'b', when: { $ref: '#/x' } }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_WORKFLOW');
    assert.ok(r.problems.some((p) => p.keyword === '$ref'));
    assert.deepEqual(lib.list(), [], 'nothing entered the library');
  });
});

test('FAIL CLOSED: missing edge contracts, cycles and dangling edges are all refused', () => {
  withLib((lib) => {
    const cases = [
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },                                     // no `when`
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', when: stringOut }, { from: 'b', to: 'a', when: stringOut }] }, // cycle
      { nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost', when: stringOut }] },                              // dangling
      { nodes: [], edges: [] },                                                                                    // no nodes
    ];
    for (const shape of cases) {
      const r = lib.save({ name: 'candidate', ...shape });
      assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(shape).slice(0, 60)}`);
      assert.equal(r.code, 'INVALID_WORKFLOW');
    }
    assert.deepEqual(lib.list(), []);
  });
});

test('names: printable names are allowed, including CJK; ambiguous or unsafe ones are refused', () => {
  withLib((lib) => {
    for (const bad of ['', '   ', ' leading', 'trailing ', '.', '..', 'a\u0000b', 'a\nb', 'a\tb', null, 42, 'x'.repeat(65)]) {
      assert.throws(() => lib.save({ name: bad, ...graph() }), TypeError, `name ${JSON.stringify(bad)} must be rejected`);
    }
    assert.deepEqual(lib.list(), []);
    // CJK and inner punctuation are fine: a name is a JSON key, not a path.
    for (const good of ['并行调查', 'investigate-v2', 'a.b', 'a/b', 'a b', '工作流 1']) {
      const r = lib.save({ name: good, ...graph() });
      assert.equal(r.ok, true, `name ${JSON.stringify(good)} must be accepted`);
    }
    assert.equal(lib.list().length, 6);
  });
});

test('a name can never become a path: the store stays exactly one file', () => {
  withLib((lib, root) => {
    lib.save({ name: '../outside', ...graph() });
    lib.save({ name: 'sub/dir', ...graph() });
    assert.equal(lib.path, join(root, 'library.json'));
    assert.deepEqual(readdirSync(root).sort(), ['library.json'], 'nothing is created beside the store');
    assert.equal(lib.has('../outside'), true, 'it is only a key');
    assert.equal(lib.get('sub/dir').name, 'sub/dir');
  });
});

test('oversized and malformed metadata is refused', () => {
  withLib((lib) => {
    assert.equal(lib.save({ name: 'long', description: 'x'.repeat(501), ...graph() }).ok, false);
    assert.equal(lib.save({ name: 'labels', labels: [1, 2], ...graph() }).ok, false);
    assert.equal(lib.save({ name: 'labels2', labels: 'not-an-array', ...graph() }).ok, false);
  });
});

test('get returns a deep copy, so a caller cannot mutate the stored entry', () => {
  withLib((lib) => {
    lib.save({ name: 'x', ...graph() });
    const copy = lib.get('x');
    copy.nodes.push({ id: 'injected' });
    copy.edges[0].when.type = 'number';
    assert.equal(lib.get('x').nodes.length, 2);
    assert.equal(lib.get('x').edges[0].when.type, 'object');
  });
});

test('list carries summaries only, not the whole graph', () => {
  withLib((lib) => {
    lib.save({ name: 'x', ...graph() });
    const [row] = lib.list();
    assert.equal(row.nodes, 2);
    assert.equal(row.edges, 1);
    assert.equal(row.nodes[0], undefined, 'list must not expose node objects');
    // `uses` is a COUNT of recorded instances; the instances themselves stay behind
    // `get()`, so a list row stays small.
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'description', 'edges', 'labels', 'name', 'nodes', 'revision', 'stats', 'updatedAt', 'uses']);
    assert.equal(row.uses, 0);
  });
});

test('rename moves the entry, refuses a taken name, and reports a missing source', () => {
  withLib((lib) => {
    lib.save({ name: 'old', ...graph() });
    lib.save({ name: 'taken', ...graph() });
    assert.equal(lib.rename('old', 'taken').code, 'NAME_TAKEN');
    assert.equal(lib.rename('ghost', 'new').code, 'NOT_FOUND');
    const r = lib.rename('old', 'new');
    assert.equal(r.code, 'RENAMED');
    assert.equal(lib.has('old'), false);
    assert.equal(lib.has('new'), true);
    assert.equal(lib.get('new').revision, 1, 'a rename is not a content change');
    assert.equal(lib.get('new').nodes.length, 2, 'the graph survives the rename');
  });
});

test('remove reports a missing name and is idempotent-safe', () => {
  withLib((lib) => {
    lib.save({ name: 'x', ...graph() });
    assert.equal(lib.remove('x').code, 'REMOVED');
    assert.equal(lib.remove('x').code, 'NOT_FOUND');
    assert.deepEqual(lib.list(), []);
  });
});

test('recordRun feeds matcher history and refuses an unknown name', () => {
  withLib((lib) => {
    lib.save({ name: 'x', ...graph() });
    assert.equal(lib.recordRun('ghost').code, 'NOT_FOUND');
    lib.recordRun('x', { success: true });
    lib.recordRun('x', { success: false });
    lib.recordRun('x');
    // No score was passed on any of these three runs, so the scored counters stay at
    // zero: an unrecorded score must not be counted as a zero score.
    assert.deepEqual(lib.list()[0].stats, { runs: 3, successes: 1, scoreSum: 0, scoredRuns: 0 });
  });
});

test('find delegates to matcher.js: an exact match reuses, an empty library creates', () => {
  withLib((lib) => {
    lib.save({ name: 'parallel-investigation', description: '拆成并行子任务后汇总', labels: ['investigation', 'parallel'], ...graph() });
    const hit = lib.find({ name: 'parallel-investigation', text: '拆成并行子任务后汇总', labels: ['investigation', 'parallel'] });
    assert.equal(hit.decision, 'reuse');
    assert.equal(hit.best.id, 'parallel-investigation');

    const miss = lib.find({ name: '完全无关的主题', text: '写一份菜谱', labels: ['cooking'] });
    assert.equal(miss.decision, 'create');
  });
  withLib((lib) => {
    const empty = lib.find({ name: 'anything' });
    assert.equal(empty.decision, 'create');
    assert.equal(empty.reason, 'empty-library');
  });
});

test('find honours matcher thresholds, so a partial match asks instead of reusing', () => {
  withLib((lib) => {
    lib.save({ name: 'x', description: 'some text here', labels: ['a', 'b'], ...graph() });
    // A PARTIAL match: the text plus one of the two labels, and deliberately NO exact
    // name -- naming an entry exactly is a lookup now, so it would bypass the
    // thresholds this test is about.
    const partial = { text: 'some text here', labels: ['a'] };
    const withDefaults = lib.find(partial);
    assert.notEqual(withDefaults.decision, 'reuse');
    assert.equal(withDefaults.best.id, 'x', 'the best candidate is identified by name');
    // Raising the reuse bar to the maximum still cannot make it a reuse.
    const strict = lib.find(partial, { reuseThreshold: 0.99 });
    assert.notEqual(strict.decision, 'reuse');
    assert.equal(strict.best.id, 'x');
  });
});

test('export/import round-trips a definition through JSON', () => {
  withLib((lib) => {
    lib.save({ name: 'x', description: 'd', labels: ['l'], ...graph() });
    const out = lib.exportOne('x');
    assert.equal(out.code, 'EXPORTED');
    assert.equal(lib.exportOne('ghost').code, 'NOT_FOUND');

    const round = lib.importOne(out.json);
    assert.equal(round.ok, true);
    assert.equal(round.code, 'REPLACED', 'the same name is a replace');
    assert.equal(round.entry.revision, 2);
    assert.equal(lib.get('x').description, 'd');
  });
});

test('import validates: broken JSON, non-objects and a bad graph are all refused without throwing', () => {
  withLib((lib) => {
    assert.equal(lib.importOne('{ not json').code, 'INVALID_JSON');
    assert.equal(lib.importOne('"a string"').code, 'INVALID_JSON');
    assert.equal(lib.importOne('[]').code, 'INVALID_JSON');
    assert.equal(lib.importOne(null).code, 'INVALID_JSON');
    // an object with no usable name is a definition problem, not a crash
    const unnamed = lib.importOne({ nodes: [], edges: [] });
    assert.equal(unnamed.code, 'INVALID_DEFINITION');
    assert.ok(unnamed.problems.length > 0);
    const bad = lib.importOne(JSON.stringify({ name: 'x', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', when: { $ref: 'x' } }] }));
    assert.equal(bad.code, 'INVALID_WORKFLOW');
    assert.deepEqual(lib.list(), [], 'nothing invalid ever entered the library');
  });
});

test('a corrupt library file is reported, never silently reset and overwritten', () => {
  withLib((lib, root) => {
    lib.save({ name: 'keep', ...graph() });
    writeFileSync(join(root, 'library.json'), '{ truncated', 'utf8');
    assert.throws(() => lib.list(), /not valid JSON/);
    assert.throws(() => lib.save({ name: 'new', ...graph() }), /not valid JSON/);
    // the operator's bytes are still there, untouched
    assert.equal(readFileSync(join(root, 'library.json'), 'utf8'), '{ truncated');
  });
});

test('a library file with the wrong shape is refused too', () => {
  withLib((lib, root) => {
    writeFileSync(join(root, 'library.json'), JSON.stringify({ version: 1, nope: {} }), 'utf8');
    assert.throws(() => lib.list(), /unexpected shape/);
  });
});

test('writes are atomic: no temp file is left behind', () => {
  withLib((lib, root) => {
    lib.save({ name: 'a', ...graph() });
    lib.save({ name: 'b', ...graph() });
    const leftovers = readdirSync(root).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });
});

test('the backing path is exposed so an operator can back it up', () => {
  withLib((lib, root) => {
    assert.equal(lib.path, join(root, 'library.json'));
  });
});

test('destroy is explicit and reports what it did', () => {
  withLib((lib) => {
    assert.equal(lib.destroy().code, 'ABSENT');
    lib.save({ name: 'x', ...graph() });
    const r = lib.destroy();
    assert.equal(r.code, 'DESTROYED');
    assert.deepEqual(lib.list(), []);
  });
});

test('two libraries with different roots are fully independent', () => {
  const a = mkdtempSync(join(tmpdir(), 'wfg-libA-'));
  const b = mkdtempSync(join(tmpdir(), 'wfg-libB-'));
  try {
    const la = createTemplateLibrary({ root: a });
    const lb = createTemplateLibrary({ root: b });
    la.save({ name: 'only-a', ...graph() });
    assert.equal(la.list().length, 1);
    assert.equal(lb.list().length, 0);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('construction validates its arguments', () => {
  assert.throws(() => createTemplateLibrary({}), TypeError);
  assert.throws(() => createTemplateLibrary({ root: '' }), TypeError);
  assert.throws(() => createTemplateLibrary({ root: 'x', now: 5 }), TypeError);
});

test('recordRun keeps an automatic score, so averages need no hand rating', () => {
  const root = mkdtempSync(join(tmpdir(), 'lib-score-'));
  const library = createTemplateLibrary({ root });
  library.save({ name: 'g', nodes: [{ id: 'a', prompt: 'A' }], edges: [] });
  library.recordRun('g', { success: true, score: 1 });
  library.recordRun('g', { success: true, score: 0.7 });
  library.recordRun('g', { success: false });
  const stats = library.list()[0].stats;
  assert.equal(stats.runs, 3);
  assert.equal(stats.successes, 2);
  assert.equal(stats.scoredRuns, 2, 'only the scored runs count toward the average');
  assert.equal(Number(stats.scoreSum.toFixed(4)), 1.7);
  rmSync(root, { recursive: true, force: true });
});