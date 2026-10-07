import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityGate, DENY, GRANT } from '../src/gate.js';

const CATALOG = ['canvas', 'budget', 'node-flow'];

function makeGate({ enabled = true, ttlMs = 1000, allowOnce = true } = {}) {
  let clock = 1_000_000;
  const gate = new CapabilityGate({ enabled, ttlMs, allowOnce, now: () => clock });
  gate.registerCapabilities(CATALOG);
  gate.assign('agent-a', ['canvas']);
  return { gate, tick: (ms) => { clock += ms; } };
}

test('R9: unassigned capabilities stay visible but are not usable', () => {
  const { gate } = makeGate();
  const view = gate.visible('agent-a');
  assert.deepEqual(view, [
    { capability: 'budget', assigned: false, usable: false },
    { capability: 'canvas', assigned: true, usable: true },
    { capability: 'node-flow', assigned: false, usable: false },
  ]);
});

test('R9: reporting a view does not spend a one-shot grant', () => {
  const { gate } = makeGate();
  const { request } = gate.requestAccess('agent-a', 'budget', '需要读取预算面板');
  gate.decide(request.id, { approve: true });
  gate.visible('agent-a');
  gate.visible('agent-a');
  assert.equal(gate.authorize('agent-a', 'budget').allowed, true);
});

test('R10: a request without a reason is refused', () => {
  const { gate } = makeGate();
  for (const reason of ['', '   ', undefined, null, 42]) {
    const r = gate.requestAccess('agent-a', 'budget', reason);
    assert.equal(r.ok, false);
    assert.equal(r.code, DENY.REASON_REQUIRED);
  }
});

test('R10: an approved request grants exactly one use by default', () => {
  const { gate } = makeGate();
  const { request } = gate.requestAccess('agent-a', 'budget', '需要读取预算面板');
  const decided = gate.decide(request.id, { approve: true });
  assert.equal(decided.status, 'approved');
  assert.equal(gate.authorize('agent-a', 'budget').allowed, true);
  const second = gate.authorize('agent-a', 'budget');
  assert.equal(second.allowed, false);
  assert.equal(second.code, DENY.CONSUMED);
});

test('a non-allow-once grant stays usable until it expires', () => {
  const { gate, tick } = makeGate({ allowOnce: false, ttlMs: 100 });
  const { request } = gate.requestAccess('agent-a', 'budget', '批量预算核对');
  gate.decide(request.id, { approve: true });
  assert.equal(gate.authorize('agent-a', 'budget').allowed, true);
  assert.equal(gate.authorize('agent-a', 'budget').allowed, true);
  tick(101);
  const expired = gate.authorize('agent-a', 'budget');
  assert.equal(expired.allowed, false);
  assert.equal(expired.code, DENY.EXPIRED);
});

test('an expired one-shot grant is reported as expired, not consumed', () => {
  const { gate, tick } = makeGate({ ttlMs: 50 });
  const { request } = gate.requestAccess('agent-a', 'node-flow', '需要节点失败策略');
  gate.decide(request.id, { approve: true });
  tick(51);
  assert.equal(gate.authorize('agent-a', 'node-flow').code, DENY.EXPIRED);
});

test('a denied request never authorizes', () => {
  const { gate } = makeGate();
  const { request } = gate.requestAccess('agent-a', 'node-flow', '想试用节点流');
  gate.decide(request.id, { approve: false, by: 'main-agent', note: '本轮不需要' });
  const r = gate.authorize('agent-a', 'node-flow');
  assert.equal(r.allowed, false);
  assert.equal(r.code, DENY.REQUEST_DENIED);
});

test('a pending request authorizes nothing and reports why', () => {
  const { gate } = makeGate();
  gate.requestAccess('agent-a', 'budget', '待裁决');
  const r = gate.authorize('agent-a', 'budget');
  assert.equal(r.allowed, false);
  assert.equal(r.code, DENY.NO_APPROVED_REQUEST);
});

test('an untouched unassigned capability is reported as not assigned', () => {
  const { gate } = makeGate();
  const r = gate.authorize('agent-a', 'budget');
  assert.equal(r.allowed, false);
  assert.equal(r.code, DENY.NOT_ASSIGNED);
});

test('failure paths are fail-closed on unknown agents, capabilities and requests', () => {
  const { gate } = makeGate();
  assert.equal(gate.requestAccess('ghost', 'budget', '理由').code, DENY.UNKNOWN_AGENT);
  assert.equal(gate.requestAccess('agent-a', 'ghost-cap', '理由').code, DENY.UNKNOWN_CAPABILITY);
  assert.equal(gate.decide('req-999', { approve: true }).code, DENY.UNKNOWN_REQUEST);
  assert.throws(() => gate.decide('', { approve: true }), TypeError);
});

test('a request is decided only once', () => {
  const { gate } = makeGate();
  const { request } = gate.requestAccess('agent-a', 'budget', '理由充分');
  gate.decide(request.id, { approve: true });
  const again = gate.decide(request.id, { approve: true });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'ALREADY_DECIDED');
});

test('an already assigned capability needs no request', () => {
  const { gate } = makeGate();
  const r = gate.requestAccess('agent-a', 'canvas', '其实已经有了');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'not-needed');
  assert.equal(r.code, GRANT.ASSIGNED);
});

test('disabling the layer delegates instead of adding a denial', () => {
  const { gate } = makeGate({ enabled: false });
  const r = gate.authorize('agent-a', 'budget');
  assert.deepEqual(r, { allowed: true, code: GRANT.NATIVE, delegated: true });
  assert.equal(gate.requestAccess('agent-a', 'budget', '理由').code, DENY.SWITCH_DISABLED);
  assert.equal(gate.decide('req-1', { approve: true }).code, DENY.SWITCH_DISABLED);
  assert.equal(gate.canUse('agent-a', 'budget'), true);
});

test('the switch can be flipped at runtime in both directions', () => {
  const { gate } = makeGate({ enabled: false });
  gate.setEnabled(true);
  assert.equal(gate.authorize('agent-a', 'budget').code, DENY.NOT_ASSIGNED);
  const { request } = gate.requestAccess('agent-a', 'budget', '理由');
  gate.setEnabled(false);
  assert.equal(gate.decide(request.id, { approve: true }).code, DENY.SWITCH_DISABLED);
  gate.setEnabled(true);
  assert.equal(gate.decide(request.id, { approve: true }).status, 'approved');
});

test('every decision is recorded in the audit log', () => {
  const { gate } = makeGate();
  const { request } = gate.requestAccess('agent-a', 'budget', '理由');
  gate.decide(request.id, { approve: true });
  gate.authorize('agent-a', 'budget');
  gate.authorize('agent-a', 'budget');
  const audit = gate.audit();
  const events = audit.map((e) => e.event);
  assert.deepEqual(events, ['assign', 'requestAccess', 'decide', 'authorize', 'authorize']);
  assert.equal(audit[3].detail.outcome, 'granted');
  assert.equal(audit[4].detail.code, DENY.CONSUMED);
  assert.deepEqual(audit.map((e) => e.seq), [1, 2, 3, 4, 5]);
});

test('the audit log is a copy and cannot be used to mutate gate state', () => {
  const { gate } = makeGate();
  const audit = gate.audit();
  audit.push({ forged: true });
  audit[0].detail.agentId = 'hacked';
  assert.equal(gate.audit().length, 1);
  assert.equal(gate.audit()[0].detail.agentId, 'agent-a');
});

test('grants are scoped per agent and cannot be reused across agents', () => {
  const { gate } = makeGate();
  gate.assign('agent-b', ['node-flow']);
  const { request } = gate.requestAccess('agent-a', 'budget', '理由');
  gate.decide(request.id, { approve: true });
  const r = gate.authorize('agent-b', 'budget');
  assert.equal(r.allowed, false);
  assert.equal(r.code, DENY.NOT_ASSIGNED);
  assert.equal(gate.authorize('agent-a', 'budget').allowed, true);
});

test('malformed identifiers are programmer errors and throw', () => {
  const { gate } = makeGate();
  assert.throws(() => gate.assign('', []), TypeError);
  assert.throws(() => gate.visible(''), TypeError);
  assert.throws(() => gate.authorize('agent-a', ''), TypeError);
  assert.throws(() => gate.registerCapabilities(['']), TypeError);
  assert.throws(() => new CapabilityGate({ ttlMs: -1 }), RangeError);
});

test('ensureKnown registers an agent WITHOUT wiping what it already holds', () => {
  // The reason this method exists: `assign` REPLACES a set, and `assigned()`
  // cannot tell "unknown" from "known with nothing", so registering a caller with
  // `assign(id, [])` would silently destroy the assignments of an agent that had
  // some other capability. That would be a privilege change nobody asked for.
  const gate = new CapabilityGate({ enabled: true });
  gate.registerCapabilities(['a', 'b']);
  gate.assign('agent-1', ['a']);

  assert.equal(gate.ensureKnown('agent-1'), false, 'an already-known agent is left alone');
  assert.deepEqual([...gate.assigned('agent-1')], ['a'], 'its assignment survived intact');
  assert.equal(gate.canUse('agent-1', 'a'), true);

  assert.equal(gate.ensureKnown('agent-2'), true, 'a new agent is registered');
  assert.deepEqual([...gate.assigned('agent-2')], [], 'and granted nothing');
  assert.equal(gate.canUse('agent-2', 'a'), false, 'least privilege: registered is not granted');

  assert.throws(() => gate.ensureKnown(''), TypeError);
  assert.equal(gate.ensureKnown('agent-2'), false, 'idempotent');
});
