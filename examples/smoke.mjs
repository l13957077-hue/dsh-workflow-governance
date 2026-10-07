/**
 * End-to-end smoke of all three gap-fillers. Run: node examples/smoke.mjs
 * Prints one compact report; exits non-zero if any expectation is violated.
 */
import assert from 'node:assert/strict';
import { createDeadlockMonitor, explainDeadlock, STATE } from '../src/deadlock.js';
import { selectTemplate } from '../src/matcher.js';
import { CapabilityGate, DENY, GRANT } from '../src/gate.js';
import { defaultConfig, mergeConfig, validateConfig } from '../src/config.js';
import { WorkflowEngineAdapter, WORKFLOW_EVENTS } from '../src/engine-adapter.js';
import { createRunObserver, projectGraph, detectStall, explainStall } from '../src/observe.js';
import { createFakeHost, goodRequest } from '../test/fake-host.mjs';

const lines = [];
const say = (s) => lines.push(s);

// --- config: independent, all switches off -----------------------------------
const cfg = defaultConfig();
assert.deepEqual(validateConfig(cfg), []);
say(`config      : 4 switches, all off = ${Object.values(cfg.switches).every((v) => v === false)}`);

// --- D6: deadlock detection + periodic escalation ----------------------------
const graph = {
  nodes: [
    { id: 'collect', status: STATE.DONE },
    { id: 'analyze', status: STATE.BLOCKED },
    { id: 'draft', status: STATE.BLOCKED },
  ],
  edges: [{ from: 'collect', to: 'analyze' }, { from: 'analyze', to: 'draft' }],
};
const escalations = [];
const monitor = createDeadlockMonitor({ escalateAfter: 3, onEscalate: (r) => escalations.push(r.scannedAt) });
let report;
for (let i = 1; i <= 4; i += 1) report = monitor.scan(graph, i * 1000);
assert.equal(report.deadlocked, true);
assert.equal(report.escalated, true);
assert.deepEqual(escalations, [3000]);
say(`D6 deadlock : deadlocked=${report.deadlocked} cause=${report.cause} escalatedAtScan=${report.consecutive} notifications=${escalations.length}`);
say(`D6 message  : ${explainDeadlock(report)}`);

// --- D4: semantic template matching -----------------------------------------
const library = [
  { id: 'wf-parallel-investigation', name: '并行调查', description: '拆成并行子任务后汇总', labels: ['investigation', 'parallel'], stats: { runs: 20, successes: 19 } },
  { id: 'wf-doc-review', name: '文档评审', description: '多角色评审后汇总意见', labels: ['review'], stats: { runs: 8, successes: 3 } },
];
const query = { name: '并行调查三个子系统', text: '拆成并行子任务后汇总结果', labels: ['investigation', 'parallel'] };
const pick = selectTemplate(query, library, cfg.matcher);
assert.equal(pick.decision, 'reuse');
say(`D4 matching : decision=${pick.decision} best=${pick.best.id} score=${pick.best.score.toFixed(4)} (label=${pick.best.labelScore.toFixed(2)} embed=${pick.best.embeddingScore.toFixed(2)} history=${pick.best.historyFactor.toFixed(2)})`);

const nothing = selectTemplate(query, [], cfg.matcher);
assert.equal(nothing.reason, 'empty-library');
say(`D4 empty    : decision=${nothing.decision} reason=${nothing.reason}`);

// --- R9/R10: capability gate -------------------------------------------------
const gate = new CapabilityGate({ enabled: true, now: () => 5_000, ttlMs: 1000 });
gate.registerCapabilities(['canvas-studio', 'budget', 'node-flow']);
gate.assign('researcher', ['canvas-studio']);

const view = gate.visible('researcher');
assert.equal(view.filter((v) => v.assigned).length, 1);
say(`R9 view     : visible=${view.length} assigned=${view.filter((v) => v.assigned).length} unassigned-but-hidden=0`);

assert.equal(gate.requestAccess('researcher', 'budget', '   ').code, DENY.REASON_REQUIRED);
const { request } = gate.requestAccess('researcher', 'budget', '需要读取预算上限以决定并行度');
gate.decide(request.id, { approve: true, by: 'main-agent' });
const first = gate.authorize('researcher', 'budget');
const second = gate.authorize('researcher', 'budget');
assert.equal(first.code, GRANT.GRANTED);
assert.equal(second.code, DENY.CONSUMED);
say(`R10 gate    : ${request.id} approved -> 1st=${first.code} 2nd=${second.code} auditEvents=${gate.audit().length}`);

const off = new CapabilityGate({ enabled: false });
assert.equal(off.authorize('researcher', 'budget').code, GRANT.NATIVE);
say(`R10 degrade : switch off -> ${GRANT.NATIVE} (delegates, adds no denial)`);

// --- independent config namespace -------------------------------------------
const custom = mergeConfig(defaultConfig(), { switches: { deadlockDetector: true }, matcher: { askThreshold: 0.7 } });
assert.deepEqual(validateConfig(custom), []);
say(`config      : merged override accepted, unknown keys dropped = ${mergeConfig(defaultConfig(), { evil: 1 }).evil === undefined}`);

// --- D5 seam adapter over ctx.workflowEngine --------------------------------
// Exercised against the documented-contract test double, NOT a real engine run:
// the shape and event ordering match docs/workflow-mode/OFFICIAL-SEAM.md, but
// no script is executed and no subagent is spawned here.
const host = createFakeHost();
const adapter = new WorkflowEngineAdapter({ engine: host.engine, ctx: host.ctx });
const observer = createRunObserver();
adapter.attach();
adapter.onObservation((o) => observer.observe(o));

const { runId } = adapter.start({ ...goodRequest(), root: true });
const run = host.runs.get(runId);
run.phase('collect');
run.startAgent(1, { phase: 'collect' });
run.endAgent(1, 'completed');
run.phase('analyze');
run.startAgent(2, { phase: 'analyze' });

const rec = observer.record(runId);
const seamGraph = projectGraph(rec);
assert.equal(seamGraph.nodes.length, 2);
assert.deepEqual(seamGraph.edges, [{ from: 'child-1', to: 'child-2' }]);
say(`D5 seam     : vocabulary=${WORKFLOW_EVENTS.length} events, run=${runId}, nodes=${seamGraph.nodes.length}, edges=${seamGraph.edgesSource}`);

const stall = detectStall(rec, { now: rec.lastActivityAt + 61_000, idleTimeoutMs: 60_000 });
assert.equal(stall.stalled, true);
say(`D6 stall    : ${stall.reason} — ${explainStall(rec, stall)}`);

// The seam guarantees an event payload carries an identity snapshot, never a live
// run, so control can never be taken from one.
assert.equal(adapter.cancel('forged-from-an-event').code, 'NOT_OWNED');

run.endAgent(2, 'completed');
run.finish({ stopReason: 'completed' });
const settled = await adapter.settle(runId);
assert.equal(settled.settled.stopReason, 'completed');
assert.equal(run.disposeCount, 1);
say(`D5 settle   : stopReason=${settled.settled.stopReason}, disposeCount=${run.disposeCount}, observerErrors=${adapter.observerErrors}`);

console.log(lines.join('\n'));
console.log('\nSMOKE OK');
