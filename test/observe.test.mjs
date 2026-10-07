import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunObserver,
  projectGraph,
  detectStall,
  explainStall,
  AGENT_STATUS,
  EDGE_POLICY,
  STALL_REASON,
} from '../src/observe.js';
import { detectDeadlock, RECOMMENDATION, STATE } from '../src/deadlock.js';

const META = { name: 'parallel-investigation', description: 'fan out and collect' };
const obs = (event, args = [], at = 0, info = { id: 'run-1', meta: META }) => ({ event, info, args, at });

function freshRecord() {
  const observer = createRunObserver();
  observer.observe(obs('workflow/start', [], 100));
  return observer;
}

const agent = (seq, over = {}) => ({ seq, childId: `child-${seq}`, label: `agent-${seq}`, phase: 'p1', ...over });

test('workflow/start creates a record with the identity snapshot', () => {
  const r = freshRecord().record('run-1');
  assert.equal(r.id, 'run-1');
  assert.deepEqual(r.meta, META);
  assert.equal(r.startedAt, 100);
  assert.equal(r.endedAt, null);
  assert.deepEqual(r.anomalies, []);
  assert.deepEqual(r.counters, { agentStarts: 0, agentEnds: 0, phases: 0, logs: 0, unrecognized: 0 });
});

test('a repeated run id is flagged, not crashed on', () => {
  const o = freshRecord();
  const again = o.observe(obs('workflow/start', [], 200));
  assert.equal(again.id, 'run-1');
  assert.deepEqual(again.anomalies, ['REPEATED_START']);
});

test('phase titles accumulate in first-seen order and dedupe', () => {
  const o = freshRecord();
  o.observe(obs('workflow/phase', ['collect'], 110));
  o.observe(obs('workflow/phase', ['analyze'], 120));
  o.observe(obs('workflow/phase', ['collect'], 130));
  const r = o.record('run-1');
  assert.deepEqual(r.phases, ['collect', 'analyze']);
  assert.equal(r.counters.phases, 3);
  assert.equal(r.lastActivityAt, 130);
});

test('logs are bounded by maxLogs while the counter counts every one', () => {
  const o = createRunObserver({ maxLogs: 2 });
  o.observe(obs('workflow/start', [], 0));
  for (const i of [1, 2, 3, 4]) o.observe(obs('workflow/log', [`m${i}`], i));
  const r = o.record('run-1');
  assert.deepEqual(r.logs.map((l) => l.message), ['m3', 'm4']);
  assert.equal(r.counters.logs, 4);
});

test('maxLogs 0 keeps the count but stores no messages', () => {
  const o = createRunObserver({ maxLogs: 0 });
  o.observe(obs('workflow/start', [], 0));
  o.observe(obs('workflow/log', ['m'], 1));
  assert.deepEqual(o.record('run-1').logs, []);
  assert.equal(o.record('run-1').counters.logs, 1);
  assert.throws(() => createRunObserver({ maxLogs: -1 }), RangeError);
});

test('agent-start opens an agent as RUNNING', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1, { phase: 'collect' })], 110));
  const r = o.record('run-1');
  const a = r.agents.get(1);
  assert.equal(a.status, AGENT_STATUS.RUNNING);
  assert.equal(a.phase, 'collect');
  assert.equal(a.startedAt, 110);
  assert.deepEqual([...r.openSeqs], [1]);
  assert.equal(r.counters.agentStarts, 1);
});

test('agent-end maps each outcome to a terminal status and closes the agent', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1)], 110));
  o.observe(obs('workflow/agent-start', [agent(2)], 111));
  o.observe(obs('workflow/agent-start', [agent(3)], 112));
  o.observe(obs('workflow/agent-end', [{ ...agent(1), outcome: 'completed' }], 120));
  o.observe(obs('workflow/agent-end', [{ ...agent(2), outcome: 'failed' }], 121));
  o.observe(obs('workflow/agent-end', [{ ...agent(3), outcome: 'cancelled' }], 122));
  const r = o.record('run-1');
  assert.equal(r.agents.get(1).status, AGENT_STATUS.DONE);
  assert.equal(r.agents.get(2).status, AGENT_STATUS.FAILED);
  assert.equal(r.agents.get(3).status, AGENT_STATUS.CANCELLED);
  assert.equal(r.openSeqs.size, 0);
  assert.equal(r.counters.agentEnds, 3);
  assert.deepEqual(r.anomalies, []);
});

test('malformed agent payloads are flagged as anomalies without throwing', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [{ seq: 0, childId: 'c' }], 110));
  o.observe(obs('workflow/agent-start', [{ seq: 1.5, childId: 'c' }], 111));
  o.observe(obs('workflow/agent-start', [agent(2)], 112));
  o.observe(obs('workflow/agent-start', [agent(2)], 113));
  o.observe(obs('workflow/agent-end', [{ ...agent(9), outcome: 'completed' }], 114));
  o.observe(obs('workflow/agent-end', [{ seq: 'x' }], 115));
  o.observe(obs('workflow/agent-start', [agent(3)], 116));
  o.observe(obs('workflow/agent-end', [{ ...agent(3), outcome: 'weird' }], 117));
  const r = o.record('run-1');
  assert.deepEqual(r.anomalies, [
    'AGENT_START_BAD_SEQ',
    'AGENT_START_BAD_SEQ',
    'REPEATED_AGENT_SEQ:2',
    'UNPAIRED_AGENT_END:9',
    'AGENT_END_BAD_SEQ',
    'UNKNOWN_OUTCOME:weird',
  ]);
  assert.equal(r.agents.get(3).status, AGENT_STATUS.FAILED, 'an unknown outcome degrades to FAILED, never to success');
});

test('a missing childId falls back to a synthetic id rather than an empty node', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [{ seq: 4, childId: '', label: 'l', phase: 'p' }], 110));
  assert.equal(o.record('run-1').agents.get(4).childId, 'seq-4');
});

test('workflow/end records the terminal result and flags open agents', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1)], 110));
  o.observe(obs('workflow/end', [{ stopReason: 'completed', agentsStarted: 1 }], 130));
  const r = o.record('run-1');
  assert.equal(r.endedAt, 130);
  assert.equal(r.result.stopReason, 'completed');
  assert.deepEqual(r.anomalies, ['OPEN_AGENTS_AT_END']);
});

test('events for an unobserved run are ignored, and an unknown event is counted', () => {
  const o = createRunObserver();
  assert.equal(o.observe(obs('workflow/phase', ['p'], 1, { id: 'never-started' })), null);
  assert.equal(o.observe(obs('workflow/phase', ['p'], 1, { id: '' })), null);
  assert.equal(o.observe({ event: 'workflow/phase', args: [] }), null);
  const o2 = freshRecord();
  o2.observe(obs('workflow/whatever', [], 110));
  assert.equal(o2.record('run-1').counters.unrecognized, 1);
});

test('projectGraph builds nodes from agents, ordered by seq', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(2, { phase: 'b' })], 110));
  o.observe(obs('workflow/agent-start', [agent(1, { phase: 'a' })], 111));
  const g = projectGraph(o.record('run-1'));
  assert.deepEqual(g.nodes.map((n) => n.seq), [1, 2]);
  assert.deepEqual(g.nodes.map((n) => n.id), ['child-1', 'child-2']);
  assert.equal(g.edgesSource, 'inferred:phase-order');
});

test('a duplicated childId is disambiguated with its seq', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1, { childId: 'same' })], 110));
  o.observe(obs('workflow/agent-start', [agent(2, { childId: 'same' })], 111));
  const ids = projectGraph(o.record('run-1')).nodes.map((n) => n.id);
  assert.deepEqual(ids, ['same', 'same#2']);
  assert.equal(new Set(ids).size, 2);
});

test('phase-chain edges join consecutive phases and never join agents inside one phase', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1, { phase: 'collect' })], 110));
  o.observe(obs('workflow/agent-start', [agent(2, { phase: 'collect' })], 111));
  o.observe(obs('workflow/agent-start', [agent(3, { phase: 'analyze' })], 112));
  const g = projectGraph(o.record('run-1'));
  assert.deepEqual(g.edges, [
    { from: 'child-1', to: 'child-3' },
    { from: 'child-2', to: 'child-3' },
  ]);
  assert.ok(!g.edges.some((e) => e.from === 'child-1' && e.to === 'child-2'), 'same-phase agents are independent (parallel)');
});

test('edgePolicy none yields no edges; an unknown policy throws', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1, { phase: 'a' })], 110));
  o.observe(obs('workflow/agent-start', [agent(2, { phase: 'b' })], 111));
  const g = projectGraph(o.record('run-1'), { edgePolicy: EDGE_POLICY.NONE });
  assert.deepEqual(g.edges, []);
  assert.equal(g.edgesSource, 'none');
  assert.throws(() => projectGraph(o.record('run-1'), { edgePolicy: 'guess' }), RangeError);
});

test('projectGraph tolerates an absent or malformed record', () => {
  for (const bad of [null, undefined, {}, { agents: [] }]) {
    const g = projectGraph(bad);
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
    assert.equal(g.edgesSource, 'none');
  }
});

test('detectStall: no record, ended, and recent activity are all not stalled', () => {
  assert.equal(detectStall(null).reason, STALL_REASON.NO_RECORD);
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1)], 100));
  assert.equal(detectStall(o.record('run-1'), { now: 100 + 10, idleTimeoutMs: 1000 }).reason, STALL_REASON.PROGRESSING);
  o.observe(obs('workflow/end', [{ stopReason: 'completed', agentsStarted: 1 }], 110));
  assert.equal(detectStall(o.record('run-1'), { now: 999_999, idleTimeoutMs: 1 }).reason, STALL_REASON.ENDED);
});

test('detectStall: a RUNNING but silent agent IS the stall (no elapsed deadline upstream)', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1)], 100));
  const stall = detectStall(o.record('run-1'), { now: 100 + 60_001, idleTimeoutMs: 60_000 });
  assert.equal(stall.stalled, true);
  assert.equal(stall.reason, STALL_REASON.RUNNING_AGENT_SILENT);
  assert.equal(stall.running, 1);
  assert.equal(stall.idleMs, 60_001);
});

test('detectStall: started, never ended, nothing running, silent -> NO_ACTIVITY', () => {
  const stall = detectStall(freshRecord().record('run-1'), { now: 100 + 5000, idleTimeoutMs: 1000 });
  assert.equal(stall.stalled, true);
  assert.equal(stall.reason, STALL_REASON.NO_ACTIVITY);
  assert.equal(stall.running, 0);
  assert.equal(stall.open, 0);
});

test('detectStall: open agents with no running agent -> OPEN_AGENTS_NO_PROGRESS', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1)], 100));
  // Force the anomalous bookkeeping the host invariant is supposed to prevent.
  const r = o.record('run-1');
  r.agents.get(1).status = AGENT_STATUS.DONE;
  const stall = detectStall(r, { now: 100 + 5000, idleTimeoutMs: 1000 });
  assert.equal(stall.reason, STALL_REASON.OPEN_AGENTS_NO_PROGRESS);
  assert.equal(stall.open, 1);
});

test('detectStall: clock skew never manufactures a stall', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1)], 100_000));
  const stall = detectStall(o.record('run-1'), { now: 50_000, idleTimeoutMs: 1 });
  assert.equal(stall.stalled, false);
  assert.equal(stall.idleMs, 0);
});

test('detectStall validates idleTimeoutMs', () => {
  assert.throws(() => detectStall(null, { idleTimeoutMs: -1 }), RangeError);
  assert.throws(() => detectStall(null, { idleTimeoutMs: Number.NaN }), RangeError);
  assert.throws(() => detectStall(null, { idleTimeoutMs: 'x' }), RangeError);
});

test('explainStall names the run and the silence for every reason', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1)], 100));
  const r = o.record('run-1');
  const silent = explainStall(r, detectStall(r, { now: 100 + 61_000, idleTimeoutMs: 60_000 }));
  assert.match(silent, /parallel-investigation/);
  assert.match(silent, /61s/);
  assert.match(silent, /转人工/);
  const progressing = explainStall(r, detectStall(r, { now: 100, idleTimeoutMs: 60_000 }));
  assert.match(progressing, /最近有进度/);
  assert.match(explainStall(r, { reason: STALL_REASON.ENDED, idleMs: 0 }), /已结算/);
  assert.match(explainStall(r, { reason: STALL_REASON.NO_ACTIVITY, idleMs: 5000 }), /停滞/);
  assert.match(explainStall(null, { reason: STALL_REASON.NO_RECORD, idleMs: 0 }), /无观测记录/);
});

// --- integration with the structural D6 detector -----------------------------

test('integration: a normal completed run produces no false deadlock alarm', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1, { phase: 'collect' })], 110));
  o.observe(obs('workflow/agent-end', [{ ...agent(1, { phase: 'collect' }), outcome: 'completed' }], 120));
  o.observe(obs('workflow/agent-start', [agent(2, { phase: 'analyze' })], 121));
  o.observe(obs('workflow/agent-end', [{ ...agent(2, { phase: 'analyze' }), outcome: 'completed' }], 130));
  o.observe(obs('workflow/end', [{ stopReason: 'completed', agentsStarted: 2 }], 131));
  const g = projectGraph(o.record('run-1'));
  const verdict = detectDeadlock(g);
  assert.equal(verdict.deadlocked, false);
  assert.equal(verdict.recommendation, RECOMMENDATION.COMPLETE);
});

test('integration: the structural detector CANNOT see a silent hang — detectStall must', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1, { phase: 'collect' })], 100));
  const r = o.record('run-1');
  const g = projectGraph(r);
  // The vocabulary has no BLOCKED state, so the node reads as RUNNING and the
  // structural detector says "still progressing" forever.
  assert.equal(g.nodes[0].status, STATE.RUNNING);
  assert.equal(detectDeadlock(g).deadlocked, false);
  // The time-based instrument is the one that catches it.
  const stall = detectStall(r, { now: 100 + 61_000, idleTimeoutMs: 60_000 });
  assert.equal(stall.stalled, true);
  assert.equal(stall.reason, STALL_REASON.RUNNING_AGENT_SILENT);
});

test('known limitation: work that never started is invisible to the projection', () => {
  const o = freshRecord();
  o.observe(obs('workflow/agent-start', [agent(1, { phase: 'collect' })], 100));
  o.observe(obs('workflow/agent-end', [{ ...agent(1, { phase: 'collect' }), outcome: 'failed' }], 110));
  // A dependent phase that the script never got to: no event, therefore no node.
  const g = projectGraph(o.record('run-1'));
  assert.equal(g.nodes.length, 1);
  assert.deepEqual(g.nodes.map((n) => n.id), ['child-1']);
  assert.equal(o.record('run-1').agents.get(1).status, AGENT_STATUS.FAILED);
  // So a poisoned dependency is reported through the record / run stopReason,
  // NOT through the graph. Documented, not silently assumed away.
  assert.equal(detectDeadlock(g).recommendation, RECOMMENDATION.COMPLETE);
});
