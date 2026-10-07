import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactStem,
  artifactFileName,
  artifactPath,
  listRunArtifacts,
  writeRunArtifact,
  pruneRunArtifacts,
  readRunArtifact,
} from '../src/artifacts.js';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'wfg-art-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const graph = () => ({
  nodes: [{ id: 'collect', prompt: 'do collect' }, { id: 'synth', prompt: 'do synth' }],
  edges: [{ from: 'collect', to: 'synth', when: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } }],
});
const result = () => ({ ok: true, status: 'COMPLETED', outputs: { synth: { text: 'done' } }, nodeResults: { collect: { status: 'DONE', attempts: 1 } }, problems: [] });

// ─────────────────────────────────────────────────────────────────── naming

test('artifactStem keeps a usable stem and never returns empty or a path', () => {
  assert.equal(artifactStem('demo'), 'demo');
  assert.equal(artifactStem('并行调查'), '并行调查');
  assert.equal(artifactStem('a/b\\c'), 'a-b-c', 'separators cannot survive');
  assert.equal(artifactStem('../../etc/passwd'), 'etc-passwd', 'no traversal characters survive');
  assert.equal(artifactStem(''), 'workflow');
  assert.equal(artifactStem('!!!'), 'workflow');
  assert.equal(artifactStem(undefined), 'workflow');
  assert.equal(artifactStem(42), 'workflow');
  assert.ok(artifactStem('x'.repeat(200)).length <= 48);
});

test('artifactFileName leads with a sortable timestamp', () => {
  const early = artifactFileName(Date.parse('2026-10-07T01:02:03.456Z'), 'demo');
  const later = artifactFileName(Date.parse('2026-10-07T02:00:00.000Z'), 'demo');
  assert.equal(early, '2026-10-07T01-02-03-456Z-demo.json');
  assert.ok(early < later, 'text order matches time order');
  assert.ok(!early.includes(':'), 'a colon is not valid in a Windows filename');
});

test('artifactPath stays inside the given root', () => {
  withRoot((root) => {
    const p = artifactPath(root, 0, '../../escape');
    assert.ok(p.startsWith(root), `escaped the root: ${p}`);
    assert.ok(!p.includes('..'), 'no traversal remains');
  });
});

// ────────────────────────────────────────────────────────────────── writing

test('a written artifact carries the topology, the diagram and the verdict', () => {
  withRoot((root) => {
    const out = writeRunArtifact({ root, name: 'demo', graph: graph(), result: result(), diagram: 'flowchart LR', at: 1000 });
    assert.equal(out.ok, true);
    const payload = JSON.parse(readFileSync(out.path, 'utf8'));
    assert.equal(payload.formatVersion, 1);
    assert.equal(payload.at, 1000);
    assert.equal(payload.name, 'demo');
    assert.equal(payload.graph.nodes.length, 2, 'R11: the full topology is saved');
    assert.equal(payload.graph.edges[0].when.required[0], 'text', 'contracts survive the round trip');
    assert.equal(payload.diagram, 'flowchart LR', 'R3 output travels with the artifact');
    assert.equal(payload.result.status, 'COMPLETED');
    assert.equal(payload.result.nodeResults.collect.attempts, 1);
    assert.deepEqual(out.pruned, []);
  });
});

test('writing is atomic: no temp file is left behind', () => {
  withRoot((root) => {
    writeRunArtifact({ root, name: 'a', at: 1 });
    writeRunArtifact({ root, name: 'b', at: 2 });
    assert.deepEqual(readdirSync(root).filter((f) => f.includes('.tmp-')), []);
  });
});

test('a missing root or an unwritable one is reported, never thrown', () => {
  assert.equal(writeRunArtifact({ root: '', name: 'x' }).code, 'NO_ROOT');
  assert.equal(writeRunArtifact({}).code, 'NO_ROOT');
  assert.doesNotThrow(() => writeRunArtifact({ root: undefined }));
  withRoot((root) => {
    // A FILE where the directory must go: mkdirSync throws, and it is returned.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'in the way', 'utf8');
    const out = writeRunArtifact({ root: blocked, name: 'x' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'WRITE_FAILED');
  });
});

test('a run result is optional and a graph may be absent entirely', () => {
  withRoot((root) => {
    const out = writeRunArtifact({ root, name: 'bare', at: 5 });
    const payload = JSON.parse(readFileSync(out.path, 'utf8'));
    assert.deepEqual(payload.graph, { nodes: [], edges: [] });
    assert.equal(payload.result, null);
    assert.equal(payload.diagram, null);
  });
});

// ────────────────────────────────────────────────────────────────── pruning

test('pruning keeps the newest N and reports what it removed', () => {
  withRoot((root) => {
    for (let i = 1; i <= 5; i += 1) writeRunArtifact({ root, name: `run${String(i)}`, at: i * 1000, maxFiles: 100 });
    assert.equal(listRunArtifacts(root).length, 5);
    const removed = pruneRunArtifacts(root, 2);
    assert.equal(removed.length, 3);
    const left = listRunArtifacts(root);
    assert.equal(left.length, 2);
    assert.match(left[1], /run5\.json$/, 'the newest survived');
    assert.match(left[0], /run4\.json$/);
  });
});

test('writeRunArtifact prunes as it writes', () => {
  withRoot((root) => {
    for (let i = 1; i <= 6; i += 1) {
      const out = writeRunArtifact({ root, name: 'same', at: i * 1000, maxFiles: 3 });
      assert.equal(out.ok, true);
    }
    assert.equal(listRunArtifacts(root).length, 3, 'the directory stays bounded');
  });
});

test('pruning is safe on an absent root, a zero limit and a hostile limit', () => {
  assert.deepEqual(pruneRunArtifacts(join(tmpdir(), 'definitely-absent-wfg'), 3), []);
  withRoot((root) => {
    writeRunArtifact({ root, name: 'a', at: 1, maxFiles: 9 });
    assert.equal(pruneRunArtifacts(root, 0).length, 1, 'a zero limit removes everything');
    assert.deepEqual(listRunArtifacts(root), []);
    assert.doesNotThrow(() => pruneRunArtifacts(root, Number.NaN));
    assert.doesNotThrow(() => pruneRunArtifacts(root, -5));
  });
});

// ────────────────────────────────────────────────────────────────── reading

test('reading back is confined to the root and total', () => {
  withRoot((root) => {
    const out = writeRunArtifact({ root, name: 'demo', graph: graph(), at: 1000 });
    const name = out.path.slice(root.length + 1);
    assert.equal(readRunArtifact(root, name).name, 'demo');
    // Escapes and junk are refused rather than read.
    assert.equal(readRunArtifact(root, '../escape.json'), null);
    assert.equal(readRunArtifact(root, 'a/b.json'), null);
    assert.equal(readRunArtifact(root, 'a\\b.json'), null);
    assert.equal(readRunArtifact(root, 'missing.json'), null);
    assert.equal(readRunArtifact(root, ''), null);
    assert.equal(readRunArtifact(undefined, name), null);
  });
});

test('a corrupt artifact reads as null instead of throwing', () => {
  withRoot((root) => {
    writeFileSync(join(root, 'broken.json'), '{ truncated', 'utf8');
    assert.equal(readRunArtifact(root, 'broken.json'), null);
  });
});
