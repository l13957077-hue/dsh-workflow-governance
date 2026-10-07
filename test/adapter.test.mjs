import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngineAdapter, WORKFLOW_EVENTS } from '../src/engine-adapter.js';
import { createFakeHost, goodRequest, FAKE_EVENTS } from './fake-host.mjs';

const setup = (opts) => {
  const host = createFakeHost(opts);
  const adapter = new WorkflowEngineAdapter({ engine: host.engine, ctx: host.ctx });
  return { ...host, adapter };
};

test('the subscribed vocabulary is exactly the verified 6 events', () => {
  assert.deepEqual([...WORKFLOW_EVENTS], [...FAKE_EVENTS]);
  assert.equal(WORKFLOW_EVENTS.length, 6);
});

test('constructor rejects a malformed engine, a missing ctx and bad options', () => {
  const { ctx } = createFakeHost();
  // A MALFORMED engine is still a programming error...
  assert.throws(() => new WorkflowEngineAdapter({ engine: {}, ctx }), TypeError);
  // ...but a MISSING one is legal: observation does not need the control seam.
  assert.doesNotThrow(() => new WorkflowEngineAdapter({ ctx }));
  assert.doesNotThrow(() => new WorkflowEngineAdapter({ engine: null, ctx }));
  assert.equal(new WorkflowEngineAdapter({ ctx }).controllable, false);
  assert.equal(new WorkflowEngineAdapter({ engine: { start() {} }, ctx }).controllable, true);

  assert.throws(() => new WorkflowEngineAdapter({ engine: { start() {} } }), TypeError, 'ctx is required');
  assert.throws(() => new WorkflowEngineAdapter({ engine: { start() {} }, ctx, maxEvents: 0 }), RangeError);
  assert.throws(() => new WorkflowEngineAdapter({ engine: { start() {} }, ctx, now: 5 }), TypeError);
});

test('an observe-only adapter watches the events, and control fails loudly', () => {
  const { ctx } = createFakeHost();
  const adapter = new WorkflowEngineAdapter({ ctx });
  const detach = adapter.attach();
  assert.equal(adapter.attached, true, 'observation works with no engine at all');
  assert.equal(ctx.listenerCount('workflow/start'), 1);
  // Reaching for control without an engine is a clear error, not a crash on null.
  assert.throws(() => adapter.start(goodRequest()), /no workflowEngine is visible/);
  assert.doesNotThrow(() => detach());
});

test('start() registers our own run and returns the id', () => {
  const { adapter } = setup();
  const { runId } = adapter.start(goodRequest());
  assert.equal(runId, 'run-1');
  assert.deepEqual(adapter.runs().map((r) => r.id), ['run-1']);
});

test('a workflow/start published SYNCHRONOUSLY inside start() is adopted as ours', () => {
  const { adapter } = setup({ emitStartSync: true });
  const seen = [];
  adapter.attach();
  adapter.onObservation((o) => seen.push(o));
  adapter.start(goodRequest());
  const start = seen.find((o) => o.event === 'workflow/start');
  assert.ok(start, 'workflow/start should have been observed');
  // The engine fired it before start() returned, so the registry was empty.
  assert.equal(start.owned, true, 'the synchronous start event must still be classified as owned');
});

test('a workflow/start published AFTER start() is also classified as ours', () => {
  const { adapter, ctx } = setup({ emitStartSync: false });
  adapter.attach();
  const seen = [];
  adapter.onObservation((o) => seen.push(o));
  const { runId } = adapter.start(goodRequest());
  ctx.emit('workflow/start', { id: runId, meta: { name: 'x', description: 'y' } });
  const start = seen.find((o) => o.event === 'workflow/start');
  assert.equal(start.owned, true);
});

test('events for a run we did not start are observed but NOT owned and not tracked', () => {
  const { adapter, ctx } = setup();
  adapter.attach();
  const seen = [];
  adapter.onObservation((o) => seen.push(o));
  ctx.emit('workflow/start', { id: 'someone-elses', meta: { name: 'other', description: 'd' } });
  ctx.emit('workflow/agent-start', { id: 'someone-elses', meta: { name: 'other', description: 'd' } }, { seq: 1, childId: 'c', label: 'l', phase: null });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((o) => o.owned === false));
  assert.deepEqual(adapter.runs(), []);
});

test('attach() subscribes all 6 events globally and is idempotent', () => {
  const { adapter, ctx, subscriptions } = setup();
  const d1 = adapter.attach();
  const d2 = adapter.attach();
  assert.equal(d1, d2, 'a second attach returns the same disposer');
  assert.equal(subscriptions.length, 6);
  for (const s of subscriptions) assert.deepEqual(s.options, { global: true }, `${s.name} must subscribe globally`);
  for (const name of WORKFLOW_EVENTS) assert.equal(ctx.listenerCount(name), 1);
});

test('detach() removes exactly our subscriptions and is idempotent', () => {
  const { adapter, ctx } = setup();
  const detach = adapter.attach();
  assert.equal(adapter.attached, true);
  detach();
  detach();
  assert.equal(adapter.attached, false);
  for (const name of WORKFLOW_EVENTS) assert.equal(ctx.listenerCount(name), 0);
  const seen = [];
  adapter.onObservation((o) => seen.push(o));
  ctx.emit('workflow/phase', { id: 'run-1' }, 'p');
  assert.deepEqual(seen, [], 'after detach nothing is observed');
});

test('a throwing observer is isolated and counted', () => {
  const { adapter, ctx } = setup();
  adapter.attach();
  const after = [];
  adapter.onObservation(() => {
    throw new Error('boom');
  });
  adapter.onObservation((o) => after.push(o.event));
  ctx.emit('workflow/phase', { id: 'run-1' }, 'p');
  assert.deepEqual(after, ['workflow/phase'], 'the second observer still ran');
  assert.equal(adapter.observerErrors, 1);
});

test("start() propagates the engine's validation error unchanged and registers nothing", () => {
  const { adapter, engine } = setup();
  const bad = { script: '', meta: { name: '', description: '' } };
  assert.throws(
    () => adapter.start(bad),
    (err) => err.code === 'WORKFLOW_INVALID_REQUEST' && err.violations.length === 3,
  );
  assert.deepEqual(adapter.runs(), []);
  assert.equal(engine.starts, 0);
});

test('start() rejects an engine that returns no run handle', () => {
  const { ctx } = createFakeHost();
  const adapter = new WorkflowEngineAdapter({ engine: { start: () => undefined }, ctx });
  assert.throws(() => adapter.start(goodRequest()), TypeError);
});

test('settle() waits for the result and always disposes exactly once', async () => {
  const { adapter, runs } = setup();
  const { runId } = adapter.start(goodRequest());
  const run = runs.get(runId);
  run.finish({ stopReason: 'completed' });
  const out = await adapter.settle(runId);
  assert.equal(out.ok, true);
  assert.equal(out.settled.stopReason, 'completed');
  assert.equal(run.disposeCount, 1);
});

test('settle() disposes even when the result rejects', async () => {
  const { ctx, runs } = createFakeHost();
  const adapter = new WorkflowEngineAdapter({ engine: { start: () => runs.get('run-1') }, ctx });
  // hand-build a run whose result rejects, to prove the finally still disposes
  let reject;
  const result = new Promise((_, rej) => {
    reject = rej;
  });
  const run = { id: 'run-1', meta: {}, result, disposeCount: 0, dispose() { this.disposeCount += 1; } };
  runs.set('run-1', run);
  const { runId } = adapter.start(goodRequest());
  reject(new Error('nope'));
  const out = await adapter.settle(runId);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'RESULT_REJECTED');
  assert.equal(run.disposeCount, 1);
});

test('settle()/cancel()/dispose() refuse a run we do not own', async () => {
  const { adapter } = setup();
  assert.equal((await adapter.settle('ghost')).code, 'NOT_OWNED');
  assert.equal(adapter.cancel('ghost').code, 'NOT_OWNED');
  assert.equal(adapter.dispose('ghost').code, 'NOT_OWNED');
  assert.equal(adapter.get('ghost'), null);
});

test('an event payload carrying cancel/dispose does NOT grant control', () => {
  const { adapter } = setup();
  adapter.attach();
  // A hostile/buggy listener-shaped payload that pretends to be a run handle.
  const forged = {
    id: 'forged-1',
    meta: { name: 'forged', description: 'forged' },
    cancel() {
      throw new Error('should never be called through the adapter');
    },
    dispose() {
      throw new Error('should never be called through the adapter');
    },
  };
  adapter.observe('workflow/start', forged, []);
  assert.equal(adapter.cancel('forged-1').code, 'NOT_OWNED');
  assert.equal(adapter.dispose('forged-1').code, 'NOT_OWNED');
  assert.equal(adapter.get('forged-1'), null);
});

test('cancel() settles the run as cancelled', async () => {
  const { adapter } = setup();
  const { runId } = adapter.start(goodRequest());
  assert.deepEqual(adapter.cancel(runId, 'user stopped it'), { ok: true });
  const out = await adapter.settle(runId);
  assert.equal(out.settled.stopReason, 'cancelled');
  assert.match(out.settled.error, /user stopped it/);
});

test('observedEvents() is a bounded ring that drops the oldest', () => {
  const host = createFakeHost();
  const adapter = new WorkflowEngineAdapter({ engine: host.engine, ctx: host.ctx, maxEvents: 3 });
  adapter.attach();
  const { runId } = adapter.start(goodRequest());
  host.runs.get(runId).phase('p1');
  host.runs.get(runId).phase('p2');
  host.runs.get(runId).phase('p3');
  const events = adapter.observedEvents();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.event), ['workflow/phase', 'workflow/phase', 'workflow/phase']);
  assert.deepEqual(events.map((e) => e.args[0]), ['p1', 'p2', 'p3']);
});

test('observedEvents() returns copies, so callers cannot corrupt the ring', () => {
  const { adapter } = setup();
  adapter.attach();
  adapter.start(goodRequest());
  const snapshot = adapter.observedEvents();
  snapshot[0].event = 'tampered';
  snapshot[0].args.push('tampered');
  assert.equal(adapter.observedEvents()[0].event, 'workflow/start');
  assert.deepEqual(adapter.observedEvents()[0].args, []);
});

test('runs() reports only our own runs, with their settled state', async () => {
  const { adapter, runs } = setup();
  const a = adapter.start(goodRequest());
  const b = adapter.start(goodRequest());
  assert.deepEqual(adapter.runs().map((r) => r.id), [a.runId, b.runId]);
  // settle() awaits run.result, so a run must actually finish first.
  runs.get(a.runId).finish({ stopReason: 'completed' });
  await adapter.settle(a.runId);
  const after = adapter.runs();
  assert.equal(after[0].settled.stopReason, 'completed');
  assert.equal(after[1].settled, null);
});

test('settle() on a run that never settles stays pending (it does not fabricate a result)', async () => {
  const { adapter } = setup();
  const { runId } = adapter.start(goodRequest());
  const sentinel = Symbol('pending');
  const outcome = await Promise.race([
    adapter.settle(runId).then(() => 'settled'),
    new Promise((r) => setTimeout(() => r(sentinel), 50)),
  ]);
  assert.equal(outcome, sentinel, 'an unsettled run must not be reported as settled');
  assert.equal(adapter.runs()[0].settled, null);
});
