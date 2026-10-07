/**
 * D6 deadlock detector + periodic scan guard (increment on top of the plugins'
 * retry/resume logic; those decide what to do, this decides when to escalate).
 *
 * Stuck is deliberately over-inclusive, because the governance action is only
 * "suspend and hand to a human":
 *   - literal rule (the stated requirement): every unfinished node is BLOCKED
 *     and nothing is RUNNING;
 *   - structural rule: nothing can start at all (no runnable node), which is
 *     what a dependency cycle or a poisoned dependency looks like.
 * Readiness is derived from the edges, not trusted from the status flag, so the
 * report can tell a genuine dependency jam from a stale BLOCKED flag.
 *
 * The detector never throws on graph input: a malformed template is reported as
 * issues so one bad template cannot kill the scan loop.
 */

export const STATE = Object.freeze({
  PENDING: 'PENDING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  SKIPPED: 'SKIPPED',
});

const STATUS_VALUES = new Set(Object.values(STATE));
const TERMINAL = new Set([STATE.DONE, STATE.FAILED, STATE.CANCELLED, STATE.SKIPPED]);
const SATISFIED = new Set([STATE.DONE, STATE.SKIPPED]);
const POISONED = new Set([STATE.FAILED, STATE.CANCELLED]);

export const RECOMMENDATION = Object.freeze({
  COMPLETE: 'COMPLETE',
  CONTINUE: 'CONTINUE',
  SUSPEND_AND_ESCALATE: 'SUSPEND_AND_ESCALATE',
  ESCALATE_POISONED: 'ESCALATE_POISONED',
});

export function isTerminal(status) {
  return TERMINAL.has(status);
}

function buildGraph(spec, issues) {
  const nodes = new Map();
  for (const n of Array.isArray(spec?.nodes) ? spec.nodes : []) {
    if (!n || typeof n.id !== 'string' || n.id === '') {
      issues.push({ code: 'BAD_NODE', detail: JSON.stringify(n) ?? String(n) });
      continue;
    }
    if (nodes.has(n.id)) {
      issues.push({ code: 'DUPLICATE_NODE', detail: n.id });
      continue;
    }
    const status = n.status ?? STATE.PENDING;
    if (!STATUS_VALUES.has(status)) {
      issues.push({ code: 'UNKNOWN_STATUS', detail: `${n.id}=${String(status)}` });
      continue;
    }
    nodes.set(n.id, { id: n.id, status, deps: new Set() });
  }
  for (const e of Array.isArray(spec?.edges) ? spec.edges : []) {
    const from = e?.from;
    const to = e?.to;
    if (!nodes.has(from) || !nodes.has(to)) {
      issues.push({ code: 'DANGLING_EDGE', detail: `${String(from)} -> ${String(to)}` });
      continue;
    }
    nodes.get(to).deps.add(from);
  }
  return nodes;
}

/** Tarjan SCC, iterative (no recursion depth limit), over non-terminal nodes. */
function findCycles(nodes) {
  const live = (id) => {
    const n = nodes.get(id);
    return n !== undefined && !TERMINAL.has(n.status);
  };
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;

  for (const root of [...nodes.keys()].filter(live)) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame[0];
      if (frame[1] === 0) {
        index.set(v, counter);
        low.set(v, counter);
        counter += 1;
        stack.push(v);
        onStack.add(v);
      }
      const deps = [...nodes.get(v).deps].filter(live);
      if (frame[1] < deps.length) {
        const w = deps[frame[1]];
        frame[1] += 1;
        if (!index.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          if (comp.length > 1) cycles.push(comp.sort());
          else if (nodes.get(v).deps.has(v)) cycles.push([v]);
        }
      }
    }
  }
  return cycles;
}

/**
 * @param {{nodes?: Array<{id: string, status?: string}>, edges?: Array<{from: string, to: string}>}} spec
 * edges: { from, to } means "to is blocked by from".
 */
export function detectDeadlock(spec) {
  const issues = [];
  const nodes = buildGraph(spec, issues);

  const nonTerminal = [];
  const running = [];
  const runnable = [];
  const staleBlocked = [];
  const blocked = [];
  const poisoned = [];

  for (const node of nodes.values()) {
    if (TERMINAL.has(node.status)) continue;
    nonTerminal.push(node.id);
    if (node.status === STATE.BLOCKED) blocked.push(node.id);

    for (const depId of node.deps) {
      const dep = nodes.get(depId);
      if (dep && POISONED.has(dep.status)) poisoned.push({ node: node.id, blocker: depId, blockerStatus: dep.status });
    }

    if (node.status === STATE.RUNNING) {
      running.push(node.id);
      continue;
    }
    const depsSatisfied = [...node.deps].every((depId) => SATISFIED.has(nodes.get(depId).status));
    if (depsSatisfied) {
      runnable.push(node.id);
      if (node.status === STATE.BLOCKED) staleBlocked.push(node.id);
    }
  }

  const cycles = findCycles(nodes);
  const allBlocked = nonTerminal.length > 0 && blocked.length === nonTerminal.length;
  const cannotStart = nonTerminal.length > 0 && runnable.length === 0;
  const deadlocked = nonTerminal.length > 0 && running.length === 0 && (allBlocked || cannotStart);

  let recommendation = RECOMMENDATION.CONTINUE;
  if (nonTerminal.length === 0) recommendation = RECOMMENDATION.COMPLETE;
  else if (deadlocked) {
    recommendation = poisoned.length > 0 ? RECOMMENDATION.ESCALATE_POISONED : RECOMMENDATION.SUSPEND_AND_ESCALATE;
  }

  return {
    ok: issues.length === 0,
    issues,
    deadlocked,
    cause: !deadlocked ? null : allBlocked && staleBlocked.length > 0 ? 'BLOCKED-FLAG-STALE' : poisoned.length > 0 ? 'POISONED-DEPENDENCY' : cycles.length > 0 ? 'DEPENDENCY-CYCLE' : 'NOTHING-RUNNABLE',
    recommendation,
    counts: {
      nodes: nodes.size,
      nonTerminal: nonTerminal.length,
      running: running.length,
      runnable: runnable.length,
      blocked: blocked.length,
      staleBlocked: staleBlocked.length,
    },
    nonTerminal,
    running,
    runnable,
    blocked,
    staleBlocked,
    poisoned,
    cycles,
  };
}

export function explainDeadlock(result) {
  if (!result || (result.ok === false && result.counts?.nodes === 0 && (result.issues?.length ?? 0) > 0)) {
    return `流程图结构有问题，无法判定：${(result?.issues ?? []).map((i) => i.code).join(', ')}`;
  }
  switch (result.recommendation) {
    case RECOMMENDATION.COMPLETE:
      return '全部节点已进入终态，流程结束。';
    case RECOMMENDATION.CONTINUE:
      return `流程仍在推进：运行中 ${result.counts.running} 个，可调度 ${result.counts.runnable} 个。`;
    case RECOMMENDATION.ESCALATE_POISONED:
      return `依赖已失败：${result.poisoned.map((p) => `${p.node}<-${p.blocker}(${p.blockerStatus})`).join(', ')}。需人工决定重跑或作废。`;
    case RECOMMENDATION.SUSPEND_AND_ESCALATE: {
      const base = `死锁：${result.counts.nonTerminal} 个未完成节点均无法推进，且无运行中节点。`;
      if (result.cause === 'BLOCKED-FLAG-STALE') {
        return `${base}其中 ${result.staleBlocked.join(', ')} 的依赖已全部满足，疑似阻塞标记过期，请复核后解除阻塞。`;
      }
      if (result.cause === 'DEPENDENCY-CYCLE') {
        return `${base}依赖成环：${result.cycles.map((c) => c.join('->')).join(' | ')}，需人工断开。`;
      }
      return `${base}挂起并转人工。`;
    }
    default:
      return '未知状态。';
  }
}

/**
 * Periodic scan guard: a single bad sample must not escalate, so escalation
 * needs `escalateAfter` consecutive stuck observations.
 */
export function createDeadlockMonitor({ scanIntervalMs = 30_000, escalateAfter = 3, onEscalate = null } = {}) {
  if (typeof scanIntervalMs !== 'number' || !Number.isFinite(scanIntervalMs) || scanIntervalMs < 0) {
    throw new RangeError('scanIntervalMs must be a finite number >= 0');
  }
  if (!Number.isInteger(escalateAfter) || escalateAfter < 1) {
    throw new RangeError('escalateAfter must be an integer >= 1');
  }
  if (onEscalate !== null && typeof onEscalate !== 'function') throw new TypeError('onEscalate must be a function or null');

  let consecutive = 0;
  let escalatedOnce = false;

  return {
    scanIntervalMs,
    escalateAfter,
    get consecutive() {
      return consecutive;
    },
    get escalated() {
      return escalatedOnce;
    },
    reset() {
      consecutive = 0;
      escalatedOnce = false;
    },
    scan(spec, now = Date.now()) {
      const result = detectDeadlock(spec);
      consecutive = result.deadlocked ? consecutive + 1 : 0;
      if (!result.deadlocked) escalatedOnce = false;
      const escalated = result.deadlocked && consecutive >= escalateAfter;
      const firstEscalation = escalated && !escalatedOnce;
      if (firstEscalation) escalatedOnce = true;
      const report = {
        ...result,
        scannedAt: now,
        consecutive,
        escalateAfter,
        escalated,
        firstEscalation,
      };
      // Notify on the rising edge only, so a long stuck streak does not spam the operator.
      if (firstEscalation && typeof onEscalate === 'function') onEscalate(report);
      return report;
    },
  };
}
