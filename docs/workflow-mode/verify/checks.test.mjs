import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, CORE_CHECKS, PLUGIN_CLAIM_CHECKS, runAll, runCore, runPluginClaims, summarize, PASS, FAIL } from './checks.mjs';

// A complete, entirely-passing synthetic trace. Each test below breaks exactly
// one field so we prove every judge actually discriminates instead of always
// returning PASS.
function goodTrace() {
  return {
    observedFrom: { command: 'test-fixture', date: '2025-01-01' },
    run: {
      command: '/workflow parallel-investigation',
      exitCode: 0,
      flowchartJsonPath: 'artifacts/flowchart.json',
      stages: [
        { name: 'collect', upstream: [], preset: 'researcher' },
        { name: 'analyze-a', upstream: ['collect'], preset: 'analyst' },
        { name: 'analyze-b', upstream: ['collect'], preset: 'analyst' },
        { name: 'synthesize', upstream: ['analyze-a', 'analyze-b'], preset: 'writer' },
      ],
      subagents: [
        { id: 'sub-collect', seesOtherSubagents: [] },
        { id: 'sub-a', seesOtherSubagents: [] },
        { id: 'sub-b', seesOtherSubagents: [] },
        { id: 'sub-synth', seesOtherSubagents: [] },
      ],
      artifacts: [
        { path: 'artifacts/result.md', kind: 'result', bytes: 8421 },
        { path: 'artifacts/flowchart.json', kind: 'flowchart', bytes: 2193 },
      ],
    },
    library: {
      emptyRun: { exitCode: 0, decision: 'create' },
      secondRun: { reused: true, resplit: false },
    },
    management: {
      add: { before: 0, after: 1 },
      rename: { before: 'old', after: 'new', renamed: true },
      delete: { before: 2, after: 1 },
    },
  };
}

const resultOf = (trace, id) => runAll(trace).find((r) => r.id === id);
const expectFail = (mutate, id, label) => {
  const t = goodTrace();
  mutate(t);
  const r = resultOf(t, id);
  assert.equal(r.status, FAIL, `${label}: expected ${id} to FAIL, measured=${r.measured}`);
  return r;
};

test('the untouched fixture passes all 10 checks', () => {
  const results = runAll(goodTrace());
  const s = summarize(results);
  assert.equal(s.total, 10);
  assert.equal(s.failed, 0, JSON.stringify(results.filter((r) => r.status === FAIL), null, 1));
  assert.equal(s.allPass, true);
});

test('the check set is exactly the 7 core + 3 plugin-claim requirements', () => {
  assert.deepEqual(CORE_CHECKS.map((c) => c.id), ['R1', 'R2', 'R4', 'R5', 'R6', 'R8', 'R13']);
  assert.deepEqual(PLUGIN_CLAIM_CHECKS.map((c) => c.id), ['R11', 'R14', 'R15']);
  assert.deepEqual(CHECKS.map((c) => c.id), ['R1', 'R2', 'R4', 'R5', 'R6', 'R8', 'R13', 'R11', 'R14', 'R15']);
  assert.equal(CORE_CHECKS.length + PLUGIN_CLAIM_CHECKS.length, 10);
});

test('the three runner views agree on the same fixture', () => {
  const t = goodTrace();
  assert.equal(runCore(t).length, 7);
  assert.equal(runPluginClaims(t).length, 3);
  assert.equal(runAll(t).length, 10);
  assert.equal(summarize(runCore(t)).allPass, true);
  assert.equal(summarize(runPluginClaims(t)).allPass, true);
});

test('a core failure does not hide behind green plugin claims', () => {
  const t = goodTrace();
  t.run.exitCode = 1;                       // R1 is core
  assert.equal(summarize(runCore(t)).failed, 1);
  assert.equal(summarize(runPluginClaims(t)).failed, 0);
  assert.equal(summarize(runAll(t)).failed, 1);
});

test('a plugin-claim failure leaves the core set green', () => {
  const t = goodTrace();
  t.library.secondRun.reused = false;       // R14 is a plugin claim
  assert.equal(summarize(runCore(t)).failed, 0);
  assert.equal(summarize(runPluginClaims(t)).failed, 1);
  assert.equal(summarize(runAll(t)).failed, 1);
});

test('a judge never throws on a completely empty trace', () => {
  const results = runAll({});
  assert.equal(results.length, 10);
  assert.ok(results.every((r) => r.status === FAIL));
  assert.ok(results.every((r) => typeof r.measured === 'string' && r.measured.length > 0));
});

test('a judge never throws on null / garbage input', () => {
  for (const junk of [null, undefined, 0, 'x', [], { run: 'nope' }, { run: { stages: 'nope' } }]) {
    const results = runAll(junk);
    assert.equal(results.length, 10, `input ${JSON.stringify(junk)}`);
    assert.ok(results.every((r) => r.status === FAIL || r.status === PASS));
  }
});

test('R1 fails on a non-zero exit code', () => {
  expectFail((t) => { t.run.exitCode = 1; }, 'R1', 'exit 1');
});

test('R1 fails when no stage was produced', () => {
  expectFail((t) => { t.run.stages = []; }, 'R1', 'zero stages');
});

test('R2 fails on a single stage', () => {
  const r = expectFail((t) => { t.run.stages = [{ name: 'only', upstream: [], preset: 'p' }]; }, 'R2', 'one stage');
  assert.match(r.measured, /stages=1/);
});

test('R2 fails on an unnamed stage', () => {
  expectFail((t) => { t.run.stages[1].name = '  '; }, 'R2', 'blank name');
});

test('R4 fails when no stage has any upstream', () => {
  const r = expectFail((t) => { t.run.stages.forEach((s) => { s.upstream = []; }); }, 'R4', 'no edges');
  assert.match(r.measured, /edges=0/);
});

test('R4 fails on a dangling upstream reference', () => {
  const r = expectFail((t) => { t.run.stages[1].upstream = ['ghost-stage']; }, 'R4', 'dangling');
  assert.match(r.evidence, /悬空/);
});

test('R4 fails on a dependency cycle', () => {
  const r = expectFail((t) => {
    t.run.stages[0].upstream = ['synthesize'];
  }, 'R4', 'cycle');
  assert.match(r.evidence, /成环/);
});

test('R4 fails on a self dependency', () => {
  expectFail((t) => { t.run.stages[1].upstream = ['analyze-a']; }, 'R4', 'self edge');
});

test('R4 fails when upstream is missing entirely', () => {
  expectFail((t) => { delete t.run.stages[2].upstream; }, 'R4', 'missing upstream');
});

test('R4 fails on duplicate stage names', () => {
  expectFail((t) => { t.run.stages[2].name = 'analyze-a'; }, 'R4', 'duplicate names');
});

test('R5 fails when the subagent count differs from the stage count', () => {
  const r = expectFail((t) => { t.run.subagents.pop(); }, 'R5', 'count mismatch');
  assert.match(r.measured, /subagents=3, stages=4/);
});

test('R6 fails when one subagent can see another', () => {
  const r = expectFail((t) => { t.run.subagents[1].seesOtherSubagents = ['sub-b']; }, 'R6', 'cross reference');
  assert.match(r.measured, /跨子代理引用=1/);
});

test('R6 fails when the isolation field is missing rather than assuming isolated', () => {
  expectFail((t) => { delete t.run.subagents[0].seesOtherSubagents; }, 'R6', 'missing field');
});

test('R6 does not count a subagent seeing its own id as contamination', () => {
  const t = goodTrace();
  t.run.subagents[1].seesOtherSubagents = ['sub-a'];
  assert.equal(resultOf(t, 'R6').status, PASS);
});

test('R6 cannot be verified with fewer than 2 subagents', () => {
  expectFail((t) => { t.run.subagents = [t.run.subagents[0]]; }, 'R6', 'single subagent');
});

test('R8 fails when a stage has no preset', () => {
  const r = expectFail((t) => { t.run.stages[3].preset = null; }, 'R8', 'missing preset');
  assert.match(r.measured, /synthesize/);
});

test('R11 fails when the flowchart artifact is missing', () => {
  const r = expectFail((t) => { t.run.artifacts = t.run.artifacts.filter((a) => a.kind !== 'flowchart'); }, 'R11', 'no flowchart');
  assert.match(r.measured, /flowchart 产物=0/);
});

test('R11 fails when an artifact is zero bytes', () => {
  const r = expectFail((t) => { t.run.artifacts[0].bytes = 0; }, 'R11', 'zero byte result');
  assert.match(r.measured, /0 字节/);
});

test('R11 fails when an artifact has no size recorded', () => {
  expectFail((t) => { delete t.run.artifacts[1].bytes; }, 'R11', 'missing bytes');
});

test('R13 fails when the empty library still reports a reuse decision', () => {
  const r = expectFail((t) => { t.library.emptyRun.decision = 'reuse'; }, 'R13', 'wrong decision');
  assert.match(r.evidence, /create/);
});

test('R13 fails when the empty-library run errored', () => {
  expectFail((t) => { t.library.emptyRun.exitCode = 1; }, 'R13', 'errored');
});

test('R14 fails when the second run re-split the task', () => {
  const r = expectFail((t) => { t.library.secondRun.resplit = true; }, 'R14', 're-split');
  assert.match(r.evidence, /重新拆分/);
});

test('R14 fails when the second run did not reuse the stored flowchart', () => {
  expectFail((t) => { t.library.secondRun.reused = false; }, 'R14', 'no reuse');
});

test('R15 fails when add did not increase the count', () => {
  const r = expectFail((t) => { t.management.add.after = 0; }, 'R15', 'add');
  assert.match(r.measured, /add/);
});

test('R15 fails when rename did not take effect', () => {
  expectFail((t) => { t.management.rename.renamed = false; }, 'R15', 'rename flag');
});

test('R15 fails when rename left the name unchanged', () => {
  expectFail((t) => { t.management.rename.after = t.management.rename.before; }, 'R15', 'rename noop');
});

test('R15 fails when delete did not decrease the count', () => {
  expectFail((t) => { t.management.delete.after = 2; }, 'R15', 'delete');
});

test('R15 reports every violated operation at once', () => {
  const r = expectFail((t) => {
    t.management.add.after = 5;
    t.management.rename.renamed = false;
    t.management.delete.after = 9;
  }, 'R15', 'all three');
  assert.match(r.measured, /3 项不符/);
});

test('summarize counts failures correctly', () => {
  const t = goodTrace();
  t.run.exitCode = 1;
  t.library.emptyRun.decision = 'reuse';
  const s = summarize(runAll(t));
  assert.equal(s.total, 10);
  assert.equal(s.passed, 8);
  assert.equal(s.failed, 2);
  assert.equal(s.allPass, false);
});
