import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE, RECOMMENDATION, detectDeadlock, explainDeadlock, createDeadlockMonitor, isTerminal } from '../src/deadlock.js';

const node = (id, status) => ({ id, status });

test('empty graph is not a deadlock and reports COMPLETE', () => {
  const r = detectDeadlock({ nodes: [], edges: [] });
  assert.equal(r.deadlocked, false);
  assert.equal(r.recommendation, RECOMMENDATION.COMPLETE);
  assert.equal(r.counts.nodes, 0);
});

test('fully finished linear chain is COMPLETE', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.DONE), node('b', STATE.DONE), node('c', STATE.DONE)],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  });
  assert.equal(r.deadlocked, false);
  assert.equal(r.recommendation, RECOMMENDATION.COMPLETE);
  assert.equal(r.counts.nonTerminal, 0);
});

test('all remaining nodes BLOCKED with nothing running is a deadlock', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.DONE), node('b', STATE.BLOCKED), node('c', STATE.BLOCKED)],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  });
  assert.equal(r.deadlocked, true);
  assert.equal(r.recommendation, RECOMMENDATION.SUSPEND_AND_ESCALATE);
  assert.equal(r.counts.running, 0);
  assert.equal(r.counts.blocked, 2);
  assert.equal(r.counts.nonTerminal, 2);
  // b's dependency is satisfied, so the structural view calls b runnable and flags it as a likely stale flag.
  assert.deepEqual(r.runnable, ['b']);
  assert.deepEqual(r.staleBlocked, ['b']);
  assert.equal(r.cause, 'BLOCKED-FLAG-STALE');
  const text = explainDeadlock(r);
  assert.ok(text.includes('死锁'));
  assert.ok(text.includes('疑似阻塞标记过期'));
});

test('one running node prevents a deadlock verdict', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.RUNNING), node('b', STATE.BLOCKED)],
    edges: [{ from: 'a', to: 'b' }],
  });
  assert.equal(r.deadlocked, false);
  assert.equal(r.recommendation, RECOMMENDATION.CONTINUE);
  assert.deepEqual(r.running, ['a']);
});

test('a runnable pending node prevents a deadlock verdict', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.DONE), node('b', STATE.PENDING)],
    edges: [{ from: 'a', to: 'b' }],
  });
  assert.equal(r.deadlocked, false);
  assert.equal(r.recommendation, RECOMMENDATION.CONTINUE);
  assert.deepEqual(r.runnable, ['b']);
});

test('a cycle is reported and is a deadlock', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.BLOCKED), node('b', STATE.BLOCKED)],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  });
  assert.equal(r.deadlocked, true);
  assert.equal(r.cycles.length, 1);
  assert.deepEqual(r.cycles[0], ['a', 'b']);
});

test('a self dependency is reported as a cycle', () => {
  const r = detectDeadlock({ nodes: [node('a', STATE.PENDING)], edges: [{ from: 'a', to: 'a' }] });
  assert.deepEqual(r.cycles, [['a']]);
  assert.equal(r.deadlocked, true);
});

test('v3-style long cycle is detected without recursion overflow', () => {
  const nodes = Array.from({ length: 3000 }, (_, i) => node(`n${i}`, STATE.PENDING));
  const edges = nodes.slice(1).map((n, i) => ({ from: `n${i}`, to: n.id }));
  edges.push({ from: 'n2999', to: 'n0' });
  const r = detectDeadlock({ nodes, edges });
  assert.equal(r.deadlocked, true);
  assert.equal(r.cycles.length, 1);
  assert.equal(r.cycles[0].length, 3000);
});

test('a failed dependency is escalated as poisoned, not as a plain deadlock', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.FAILED), node('b', STATE.PENDING)],
    edges: [{ from: 'a', to: 'b' }],
  });
  assert.equal(r.deadlocked, true);
  assert.equal(r.recommendation, RECOMMENDATION.ESCALATE_POISONED);
  assert.equal(r.cause, 'POISONED-DEPENDENCY');
  assert.deepEqual(r.poisoned, [{ node: 'b', blocker: 'a', blockerStatus: STATE.FAILED }]);
  assert.ok(explainDeadlock(r).includes('依赖已失败'));
});

test('a stale BLOCKED flag is escalated but labelled, not reported as a cycle', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.DONE), node('b', STATE.BLOCKED)],
    edges: [{ from: 'a', to: 'b' }],
  });
  assert.equal(r.deadlocked, true);
  assert.deepEqual(r.staleBlocked, ['b']);
  assert.equal(r.cause, 'BLOCKED-FLAG-STALE');
  assert.deepEqual(r.cycles, []);
  assert.ok(explainDeadlock(r).includes('复核后解除阻塞'));
});

test('a dependency cycle is escalated and named', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.PENDING), node('b', STATE.PENDING)],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  });
  assert.equal(r.cause, 'DEPENDENCY-CYCLE');
  assert.ok(explainDeadlock(r).includes('依赖成环'));
});

test('SKIPPED satisfies a dependency', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.SKIPPED), node('b', STATE.PENDING)],
    edges: [{ from: 'a', to: 'b' }],
  });
  assert.equal(r.deadlocked, false);
  assert.deepEqual(r.runnable, ['b']);
});

test('malformed input is reported as issues instead of throwing', () => {
  const r = detectDeadlock({
    nodes: [node('a', STATE.PENDING), node('a', STATE.DONE), { id: '' }, { id: 'z', status: 'WAT' }],
    edges: [{ from: 'a', to: 'ghost' }],
  });
  assert.equal(r.ok, false);
  const codes = r.issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['BAD_NODE', 'DANGLING_EDGE', 'DUPLICATE_NODE', 'UNKNOWN_STATUS']);
  assert.equal(r.counts.nodes, 1);
});

test('a completely unparsable graph explains itself rather than reporting a deadlock', () => {
  const r = detectDeadlock({ nodes: [{ id: '' }], edges: [] });
  assert.equal(r.deadlocked, false);
  assert.ok(explainDeadlock(r).includes('结构有问题'));
});

test('detector tolerates a missing spec', () => {
  const r = detectDeadlock(undefined);
  assert.equal(r.deadlocked, false);
  assert.equal(r.recommendation, RECOMMENDATION.COMPLETE);
});

test('isTerminal covers exactly the four terminal states', () => {
  assert.deepEqual(
    Object.values(STATE).filter(isTerminal).sort(),
    ['CANCELLED', 'DONE', 'FAILED', 'SKIPPED'],
  );
});

const STUCK = { nodes: [node('a', STATE.BLOCKED)], edges: [] };
const MOVING = { nodes: [node('a', STATE.RUNNING)], edges: [] };

test('one stuck sample is not enough to escalate', () => {
  const monitor = createDeadlockMonitor({ escalateAfter: 3 });
  const r1 = monitor.scan(STUCK, 1);
  assert.equal(r1.deadlocked, true);
  assert.equal(r1.escalated, false);
  assert.equal(r1.consecutive, 1);
  assert.equal(monitor.scan(STUCK, 2).escalated, false);
  const r3 = monitor.scan(STUCK, 3);
  assert.equal(r3.escalated, true);
  assert.equal(r3.consecutive, 3);
  assert.equal(r3.firstEscalation, true);
});

test('the escalation callback fires once per stuck streak, on the rising edge', () => {
  const seen = [];
  const monitor = createDeadlockMonitor({ escalateAfter: 2, onEscalate: (r) => seen.push(r.scannedAt) });
  monitor.scan(STUCK, 10);
  monitor.scan(STUCK, 20);
  monitor.scan(STUCK, 30);
  assert.deepEqual(seen, [20]);
  assert.equal(monitor.scan(STUCK, 40).firstEscalation, false);
  assert.deepEqual(seen, [20]);
});

test('recovery resets the streak and allows a later escalation to notify again', () => {
  const seen = [];
  const monitor = createDeadlockMonitor({ escalateAfter: 2, onEscalate: (r) => seen.push(r.scannedAt) });
  monitor.scan(STUCK, 1);
  monitor.scan(STUCK, 2);
  const recovered = monitor.scan(MOVING, 3);
  assert.equal(recovered.consecutive, 0);
  assert.equal(recovered.escalated, false);
  monitor.scan(STUCK, 4);
  monitor.scan(STUCK, 5);
  assert.deepEqual(seen, [2, 5]);
});

test('a completed run never escalates', () => {
  const monitor = createDeadlockMonitor({ escalateAfter: 1 });
  const r = monitor.scan({ nodes: [node('a', STATE.DONE)], edges: [] }, 1);
  assert.equal(r.recommendation, RECOMMENDATION.COMPLETE);
  assert.equal(r.escalated, false);
});

test('monitor options are validated', () => {
  assert.throws(() => createDeadlockMonitor({ escalateAfter: 0 }), RangeError);
  assert.throws(() => createDeadlockMonitor({ escalateAfter: 1.5 }), RangeError);
  assert.throws(() => createDeadlockMonitor({ scanIntervalMs: -1 }), RangeError);
  assert.throws(() => createDeadlockMonitor({ onEscalate: 'nope' }), TypeError);
});
