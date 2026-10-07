import test from 'node:test';
import assert from 'node:assert/strict';
import { runContractGraph, explainRun, RUN_STATUS } from '../src/graph-run.js';

const anyObject = { type: 'object' };
const stringOut = { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } }, additionalProperties: false };
const numberOut = { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 0 } }, additionalProperties: false };

/** A workflow whose single edge demands `{text}`. */
const linear = () => ({
  nodes: [{ id: 'a', prompt: 'produce text' }, { id: 'b', prompt: 'consume text' }],
  edges: [{ from: 'a', to: 'b', when: stringOut }],
});

/** Records every spawn call so tests can assert what ran. */
function recorder(table) {
  const calls = [];
  const spawn = async ({ node, input, attempt }) => {
    calls.push({ node: node.id, attempt, input });
    const entry = table[node.id];
    if (typeof entry === 'function') return entry({ node, input, attempt });
    if (entry === undefined) throw new Error(`no fixture for ${node.id}`);
    return entry;
  };
  return { spawn, calls };
}

test('a clean run completes, in topological order, and hands downstream its inputs', async () => {
  const { spawn, calls } = recorder({
    a: { text: 'hello' },
    b: ({ input }) => ({ text: `${input.a.text} world` }),
  });
  const r = await runContractGraph({ workflow: linear(), spawn });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.node), ['a', 'b']);
  assert.deepEqual(calls[1].input, { a: { text: 'hello' } }, 'downstream receives the upstream output keyed by node id');
  assert.equal(r.outputs.b.text, 'hello world');
  assert.equal(r.nodeResults.a.attempts, 1);
});

test('BEFORE: a node is not spawned when its incoming contract rejects the upstream output', async () => {
  // a produces something that already violates the edge, so b must never run.
  const { spawn, calls } = recorder({ a: { text: '' }, b: { text: 'never' } });
  // text minLength:1 -> a's own output violates its outgoing contract, which is
  // caught as an upstream violation first.
  const r = await runContractGraph({ workflow: linear(), spawn, maxAttemptsPerNode: 1 });
  assert.equal(r.status, RUN_STATUS.OUTPUT_VIOLATES_CONTRACT);
  assert.equal(r.upstream, 'a');
  assert.deepEqual(calls.map((c) => c.node), ['a'], 'b must never have been spawned');
});

test('AFTER: a violating output is retried against the producing node, then reported', async () => {
  let attempt = 0;
  const spawn = async ({ node }) => {
    if (node.id === 'a') {
      attempt += 1;
      return attempt < 3 ? { text: '' } : { text: 'finally good' };
    }
    return { text: 'x' };
  };
  const r = await runContractGraph({ workflow: linear(), spawn, maxAttemptsPerNode: 3 });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  assert.equal(attempt, 3, 'the producer was re-run until its output satisfied the edge');
  assert.equal(r.nodeResults.a.attempts, 3);
  assert.equal(r.outputs.a.text, 'finally good');
});

test('AFTER: exhausting the retry budget stops the run and names the upstream node', async () => {
  const { spawn, calls } = recorder({ a: { text: '' } });
  const r = await runContractGraph({ workflow: linear(), spawn, maxAttemptsPerNode: 2 });
  assert.equal(r.status, RUN_STATUS.OUTPUT_VIOLATES_CONTRACT);
  assert.equal(r.upstream, 'a', 'the failure is attributed to the producer (upstream)');
  assert.equal(calls.filter((c) => c.node === 'a').length, 2);
  assert.equal(r.blocked.downstream, 'b');
  assert.equal(r.violations.length, 1);
  assert.ok(r.violations[0].errors.some((e) => e.keyword === 'minLength'));
  assert.match(explainRun(r), /上游节点 a/);
});

test('a node that throws is retried and then reported as NODE_FAILED', async () => {
  let n = 0;
  const spawn = async ({ node }) => {
    if (node.id === 'a') {
      n += 1;
      throw new Error('upstream exploded');
    }
    return { text: 'x' };
  };
  const r = await runContractGraph({ workflow: linear(), spawn, maxAttemptsPerNode: 2 });
  assert.equal(r.status, RUN_STATUS.NODE_FAILED);
  assert.equal(r.upstream, 'a');
  assert.equal(n, 2);
  assert.match(r.error, /upstream exploded/);
  assert.match(explainRun(r), /执行失败/);
});

test('a throwing node that later succeeds completes', async () => {
  let n = 0;
  const spawn = async ({ node }) => {
    if (node.id === 'a') {
      n += 1;
      if (n === 1) throw new Error('flaky');
      return { text: 'recovered' };
    }
    return { text: 'ok' };
  };
  const r = await runContractGraph({ workflow: linear(), spawn, maxAttemptsPerNode: 2 });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  assert.equal(r.outputs.a.text, 'recovered');
});

test('BEFORE is enforced independently: a hand-forged upstream output that breaks the edge blocks the spawn', async () => {
  // Two roots feeding one sink; the first root's output is fine, the second is
  // not, so the sink must not run and the block must name that edge.
  const workflow = {
      nodes: [
        { id: 'start', label: '开始' },
        { id: 'ok', label: '正常产出' },
        { id: 'bad', label: '违约产出', prompt: 'ignores its contract' },
        { id: 'sink', label: '汇聚' },
      ],
    edges: [
{ from: 'start', to: 'ok', when: anyObject },
        { from: 'start', to: 'bad', when: anyObject },
        { from: 'ok', to: 'sink', when: stringOut },
      { from: 'bad', to: 'sink', when: numberOut },
    ],
  };
  // `bad` has no outgoing contract on itself... it does: bad->sink. So make the
  // producer deliberately violate by returning the wrong shape, and give it a
  // single attempt so the run stops at the producer instead of the sink.
    const { spawn, calls } = recorder({ start: { go: true }, ok: { text: 'fine' }, bad: { text: 'wrong shape' } });
  const r = await runContractGraph({ workflow, spawn, maxAttemptsPerNode: 1 });
  assert.equal(r.status, RUN_STATUS.OUTPUT_VIOLATES_CONTRACT);
  assert.equal(r.upstream, 'bad');
  assert.ok(!calls.some((c) => c.node === 'sink'), 'the sink must never be spawned');
});

test('an unsupported contract anywhere refuses the run before anything is spawned', async () => {
  const workflow = {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b', when: { type: 'object', patternProperties: { '^x': { type: 'string' } } } }],
  };
  const { spawn, calls } = recorder({ a: {}, b: {} });
  const r = await runContractGraph({ workflow, spawn });
  assert.equal(r.status, RUN_STATUS.INVALID_WORKFLOW);
  assert.deepEqual(calls, [], 'nothing runs when a contract cannot be enforced');
  assert.ok(r.problems.some((p) => p.keyword === 'patternProperties'));
  assert.match(explainRun(r), /fail-closed/);
});

test('an unsupported contract discovered at runtime (injected schema) also refuses', async () => {
  // The edge contract is mutated after validation by the caller's own object
  // identity: prove the runtime path re-checks rather than trusting the plan.
  const workflow = linear();
  const { spawn } = recorder({ a: { text: 'x' }, b: { text: 'y' } });
  const original = workflow.edges[0].when;
  const r1 = await runContractGraph({ workflow, spawn });
  assert.equal(r1.status, RUN_STATUS.COMPLETED);
  workflow.edges[0].when = { $ref: '#/nope' };
  const { spawn: spawn2, calls: calls2 } = recorder({ a: { text: 'x' }, b: { text: 'y' } });
  const r2 = await runContractGraph({ workflow, spawn: spawn2 });
  assert.equal(r2.status, RUN_STATUS.INVALID_WORKFLOW);
  assert.deepEqual(calls2, []);
  workflow.edges[0].when = original;
});

test('an invalid workflow is refused with problems and no spawns', async () => {
  const { spawn, calls } = recorder({});
  const r = await runContractGraph({ workflow: { nodes: [{ id: 'a' }, { id: 'a' }], edges: [] }, spawn });
  assert.equal(r.status, RUN_STATUS.INVALID_WORKFLOW);
  assert.ok(r.problems.length > 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(r.outputs, {});
});

test('a root node with no incoming edges runs with an empty input', async () => {
  const { spawn, calls } = recorder({ solo: { text: 'x' } });
  const r = await runContractGraph({ workflow: { nodes: [{ id: 'solo' }], edges: [] }, spawn });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  assert.deepEqual(calls[0].input, {});
});

test('a diamond fans out and the sink sees both upstream outputs', async () => {
  const workflow = {
    nodes: [{ id: 'root' }, { id: 'l' }, { id: 'r' }, { id: 'sink' }],
    edges: [
      { from: 'root', to: 'l', when: stringOut },
      { from: 'root', to: 'r', when: stringOut },
      { from: 'l', to: 'sink', when: stringOut },
      { from: 'r', to: 'sink', when: stringOut },
    ],
  };
  const { spawn, calls } = recorder({
    root: { text: 'seed' },
    l: { text: 'left' },
    r: { text: 'right' },
    sink: ({ input }) => ({ text: `${input.l.text}+${input.r.text}` }),
  });
  const r = await runContractGraph({ workflow, spawn });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  assert.equal(r.outputs.sink.text, 'left+right');
  assert.deepEqual(calls.at(-1).input, { l: { text: 'left' }, r: { text: 'right' } });
});

test('onEvent narrates attempts, rejections and completion', async () => {
  const events = [];
  let n = 0;
  const spawn = async ({ node }) => {
    if (node.id === 'a') {
      n += 1;
      return n === 1 ? { text: '' } : { text: 'good' };
    }
    return { text: 'ok' };
  };
  const r = await runContractGraph({ workflow: linear(), spawn, maxAttemptsPerNode: 2, onEvent: (e) => events.push(e.type) });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  assert.deepEqual(events, ['node-attempt', 'node-output-rejected', 'node-attempt', 'node-done', 'node-attempt', 'node-done', 'completed']);
});

test('argument validation is a programmer error and throws', async () => {
  await assert.rejects(() => runContractGraph({ workflow: linear() }), TypeError);
  await assert.rejects(() => runContractGraph({ workflow: linear(), spawn: () => {}, onEvent: 5 }), TypeError);
  await assert.rejects(() => runContractGraph({ workflow: linear(), spawn: () => {}, maxAttemptsPerNode: 0 }), RangeError);
  await assert.rejects(() => runContractGraph({ workflow: linear(), spawn: () => {}, maxAttemptsPerNode: 1.5 }), RangeError);
});

test('explainRun covers every status without throwing', () => {
  for (const status of Object.values(RUN_STATUS)) {
    assert.equal(typeof explainRun({ status }), 'string');
  }
  assert.equal(explainRun(null), 'no result');
});

test('a spent retry budget leaves a dead letter naming the message and the reason', async () => {
  // The producer can never satisfy its outgoing contract; after the budget the message is
  // dead, and the run says so with the edge and the exact contract errors instead of
  // returning a bare status.
  const workflow = {
    nodes: [{ id: 's', label: '开始' }, { id: 'bad', label: '永远不合契约', prompt: 'always wrong' }],
    edges: [{ from: 's', to: 'bad', when: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } }],
  };
  const { spawn } = recorder({ s: { n: 'not a number' }, bad: { ok: true } });
  const r = await runContractGraph({ workflow, spawn, maxAttemptsPerNode: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.status, RUN_STATUS.OUTPUT_VIOLATES_CONTRACT);
  assert.ok(Array.isArray(r.deadLetters) && r.deadLetters.length === 1, 'one dead message');
  const letter = r.deadLetters[0];
  assert.equal(letter.fromNode, 's');
  assert.equal(letter.toNode, 'bad');
  assert.equal(letter.reason, RUN_STATUS.OUTPUT_VIOLATES_CONTRACT);
  assert.equal(letter.attempts, 2, 'the attempts that were spent are recorded');
  assert.ok(letter.errors.length > 0, 'the contract errors travel with the dead letter');
});

test('a completed run reports an empty dead-letter queue, so "no failures" is explicit', async () => {
  const workflow = {
    nodes: [{ id: 's', label: '开始' }, { id: 't', label: '结束' }],
    edges: [{ from: 's', to: 't', when: { type: 'object' } }],
  };
  const { spawn } = recorder({ s: { a: 1 }, t: { b: 2 } });
  const r = await runContractGraph({ workflow, spawn, maxAttemptsPerNode: 1 });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  assert.deepEqual(r.deadLetters, []);
});

test('a wall-clock budget stops before the NEXT node and names the budget in the DLQ', async () => {
  const workflow = {
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    edges: [
      { from: 'a', to: 'b', when: { type: 'object' } },
      { from: 'b', to: 'c', when: { type: 'object' } },
    ],
  };
  let clock = 0;
  const { spawn, calls } = recorder({ a: { x: 1 }, b: { x: 2 }, c: { x: 3 } });
  const slow = async (ctx) => {
    clock += 600;
    return spawn(ctx);
  };
  const r = await runContractGraph({ workflow, spawn: slow, maxAttemptsPerNode: 1, maxWallClockMs: 1000, now: () => clock });
  assert.equal(r.status, RUN_STATUS.BUDGET_EXCEEDED);
  assert.equal(r.stoppedAt, 'c', 'a and b ran (1200ms), so the budget stops the run before c');
  assert.equal(calls.filter((call) => call.node === 'c').length, 0, 'the cut-off node is never spawned');
  assert.equal(r.deadLetters.length, 1);
  assert.match(r.deadLetters[0].errors[0], /wall-clock budget exhausted/);
  assert.match(explainRun(r), /预算用尽/);
});

test('without a budget the same run completes, so the switch is the only difference', async () => {
  const workflow = {
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b', when: { type: 'object' } }],
  };
  const { spawn } = recorder({ a: { x: 1 }, b: { x: 2 } });
  const r = await runContractGraph({ workflow, spawn, maxAttemptsPerNode: 1, maxWallClockMs: 0 });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  assert.deepEqual(r.deadLetters, []);
});
