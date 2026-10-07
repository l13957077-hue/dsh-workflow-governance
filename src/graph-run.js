/**
 * R7 / D1: the contract-gated graph driver.
 *
 * The official `workflow` tool runs a model-written script whose `agent()` calls
 * cross no declared contract, and the engine owns that VM, so a contract layer
 * cannot intercept it from outside. This driver therefore owns the whole graph
 * instead: the caller supplies the DAG once, and every node transition is
 * checked against the edge's `when` contract.
 *
 *   before spawning a node : its incoming edges' contracts must admit the
 *                            upstream outputs, otherwise nothing is spawned
 *   after  spawning a node : its output must satisfy every outgoing edge's
 *                            contract, otherwise the producer is re-run
 *                            ("failure goes back upstream"), and only after the
 *                            retry budget is spent does the run stop
 *
 * The spawn function is injected, so this whole module is testable without a
 * host, and the real wiring (`ctx.agents.create(...).followup(...)`) is a thin,
 * guarded adapter in lib/index.js.
 */
import { validateContract, validateWorkflow } from './contract.js';

export const RUN_STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  INVALID_WORKFLOW: 'INVALID_WORKFLOW',
  BLOCKED_BY_CONTRACT: 'BLOCKED_BY_CONTRACT',
  OUTPUT_VIOLATES_CONTRACT: 'OUTPUT_VIOLATES_CONTRACT',
  NODE_FAILED: 'NODE_FAILED',
    BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
});

const noop = () => {};

/**
 * @param {object} options
 * @param {{nodes: Array<{id: string, prompt?: string, [k: string]: unknown}>, edges: Array<{from: string, to: string, when: unknown}>}} options.workflow
 * @param {(ctx: {node: object, input: object, attempt: number}) => Promise<unknown>} options.spawn
 * @param {number} [options.maxAttemptsPerNode] retries for a node whose output violates a contract
 * @param {() => number} [options.now]
 * @param {(event: object) => void} [options.onEvent]
 */
export async function runContractGraph({ workflow, spawn, maxAttemptsPerNode = 2, maxWallClockMs = 0, now = Date.now, onEvent = noop } = {}) {
  if (!Number.isFinite(maxWallClockMs) || maxWallClockMs < 0) {
    throw new RangeError('maxWallClockMs must be a non-negative finite number (0 disables the budget)');
  }
  if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
  if (!Number.isInteger(maxAttemptsPerNode) || maxAttemptsPerNode < 1) {
    throw new RangeError('maxAttemptsPerNode must be an integer >= 1');
  }

  const validated = validateWorkflow(workflow);
  if (!validated.ok) {
    return {
      ok: false,
      status: RUN_STATUS.INVALID_WORKFLOW,
      problems: validated.problems,
      nodeResults: {},
      outputs: {},
    };
  }

  const nodesById = new Map(workflow.nodes.map((n) => [n.id, n]));
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const incoming = new Map(workflow.nodes.map((n) => [n.id, []]));
  const outgoing = new Map(workflow.nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    incoming.get(edge.to).push(edge);
    outgoing.get(edge.from).push(edge);
  }

  const nodeResults = {};
  /** Undeliverable messages: a spent retry budget always leaves a reason behind. */
  const deadLetters = [];
  const outputs = {};
  const startedAt = now();

  for (const id of validated.order) {
    const node = nodesById.get(id);
    const inEdges = incoming.get(id);

    // ---- BEFORE: the incoming contracts must admit what upstream produced ----
    const input = {};
    for (const edge of inEdges) {
      const upstreamOutput = outputs[edge.from];
      const verdict = validateContract(upstreamOutput, edge.when, `#/edges/${edge.from}->${edge.to}/when`);
      if (verdict.unsupported) {
        return {
          ok: false,
          status: RUN_STATUS.INVALID_WORKFLOW,
          problems: verdict.problems,
          nodeResults,
          outputs,
          blocked: { edge, upstream: edge.from, downstream: edge.to },
        };
      }
      if (!verdict.ok) {
        onEvent({ type: 'blocked', node: id, edge, upstream: edge.from, at: now() });
        return {
          ok: false,
          status: RUN_STATUS.BLOCKED_BY_CONTRACT,
          nodeResults,
          outputs,
          blocked: { edge, upstream: edge.from, downstream: edge.to, errors: verdict.errors },
        };
      }
      input[edge.from] = upstreamOutput;
    }

// ---- the wall-clock budget: checked before the work, not after ----
if (maxWallClockMs > 0) {
  const elapsed = now() - startedAt;
  if (elapsed > maxWallClockMs) {
    onEvent({ type: 'budget-exceeded', node: id, elapsedMs: elapsed, at: now() });
    deadLetters.push({
      toNode: null,
      fromNode: null,
      edge: null,
      reason: RUN_STATUS.BUDGET_EXCEEDED,
      attempts: null,
      errors: [`wall-clock budget exhausted before node '${id}': ${elapsed}ms > ${maxWallClockMs}ms`],
    });
    return { ok: false, status: RUN_STATUS.BUDGET_EXCEEDED, nodeResults, outputs, stoppedAt: id, elapsedMs: elapsed, maxWallClockMs, deadLetters };
  }
  if (elapsed > maxWallClockMs * 0.8) {
    onEvent({ type: 'budget-warning', node: id, elapsedMs: elapsed, at: now() });
  }
}

    // ---- spawn, and re-run the producer while its output breaks a contract ----
    const outEdges = outgoing.get(id);
    let settled = false;
    let lastViolations = null;
    let lastSpawnError = null;

    for (let attempt = 1; attempt <= maxAttemptsPerNode && !settled; attempt += 1) {
      onEvent({ type: 'node-attempt', node: id, attempt, at: now() });
      let output;
      try {
        output = await spawn({ node, input, attempt, outEdges });
      } catch (error) {
        lastSpawnError = error;
        onEvent({ type: 'node-threw', node: id, attempt, message: String(error && error.message ? error.message : error), at: now() });
        continue;
      }

      const violations = [];
      for (const edge of outEdges) {
        const verdict = validateContract(output, edge.when, `#/edges/${edge.from}->${edge.to}/when`);
        if (verdict.unsupported) {
          return {
            ok: false,
            status: RUN_STATUS.INVALID_WORKFLOW,
            problems: verdict.problems,
            nodeResults,
            outputs,
            blocked: { edge, upstream: edge.from, downstream: edge.to },
          };
        }
        if (!verdict.ok) violations.push({ edge, errors: verdict.errors });
      }

      if (violations.length === 0) {
        outputs[id] = output;
        nodeResults[id] = { status: 'DONE', attempts: attempt, output };
        settled = true;
        onEvent({ type: 'node-done', node: id, attempt, at: now() });
        continue;
      }

      // Failure goes back upstream: this node produced inadmissible data.
      lastViolations = violations;
      nodeResults[id] = { status: 'CONTRACT_VIOLATION', attempts: attempt, output };
      onEvent({
        type: 'node-output-rejected',
        node: id,
        attempt,
        edges: violations.map((v) => `${v.edge.from}->${v.edge.to}`),
        at: now(),
      });
    }

    if (!settled) {
      if (lastViolations) {
        const first = lastViolations[0];
        // The retry budget is spent on a producer whose output no downstream contract
        // admits: the message is dead. It goes to the DLQ with the reason and the exact
        // contract errors, so the failure is actionable instead of a bare status.
        deadLetters.push({
          toNode: first.edge.to,
          fromNode: id,
          edge: { from: first.edge.from, to: first.edge.to },
          reason: RUN_STATUS.OUTPUT_VIOLATES_CONTRACT,
          attempts: nodeResults[id]?.attempts ?? null,
          errors: first.errors ?? [],
        });
        return {
          ok: false,
          status: RUN_STATUS.OUTPUT_VIOLATES_CONTRACT,
          nodeResults,
          outputs,
          // the producer that must be fixed or replaced
          upstream: id,
          violations: lastViolations.map((v) => ({ edge: v.edge, errors: v.errors })),
          blocked: { edge: first.edge, upstream: id, downstream: first.edge.to, errors: first.errors },
          deadLetters,
        };
      }
      deadLetters.push({
        toNode: null,
        fromNode: id,
        edge: null,
        reason: RUN_STATUS.NODE_FAILED,
        attempts: nodeResults[id]?.attempts ?? null,
        errors: [String(lastSpawnError && lastSpawnError.message ? lastSpawnError.message : lastSpawnError)],
      });
      return {
        ok: false,
        status: RUN_STATUS.NODE_FAILED,
        nodeResults,
        outputs,
        upstream: id,
        error: String(lastSpawnError && lastSpawnError.message ? lastSpawnError.message : lastSpawnError),
        deadLetters,
      };
    }
  }

  onEvent({ type: 'completed', elapsedMs: now() - startedAt, at: now() });
  return { ok: true, status: RUN_STATUS.COMPLETED, nodeResults, outputs, problems: [], deadLetters };
}

/**
 * Render a run verdict. Deliberately total: a diagnostic must never be the thing
 * that throws while reporting a failure, so every field is optional here.
 */
export function explainRun(result) {
  if (!result || typeof result !== 'object') return 'no result';
  const errs = (list) =>
    (Array.isArray(list) ? list : []).map((e) => `${e && e.path ? e.path : '?'} ${e && e.keyword ? e.keyword : '?'}: ${e && e.message ? e.message : ''}`).join('; ');
  const probs = (list) =>
    (Array.isArray(list) ? list : []).map((p) => `${p && p.path ? p.path : '?'} ${p && p.keyword ? p.keyword : '?'}: ${p && p.message ? p.message : ''}`).join('; ');
  const blocked = result.blocked && typeof result.blocked === 'object' ? result.blocked : {};

  switch (result.status) {
    case RUN_STATUS.COMPLETED:
      return `工作流完成：${Object.keys(result.outputs ?? {}).length} 个节点全部产出且通过边契约。`;
    case RUN_STATUS.INVALID_WORKFLOW:
      return `工作流定义被拒（fail-closed）：${probs(result.problems) || '(无细节)'}`;
    case RUN_STATUS.BLOCKED_BY_CONTRACT:
      return `入边契约不通过，已阻止启动下游节点：${blocked.upstream ?? '?'}->${blocked.downstream ?? '?'}；${errs(blocked.errors) || '(无细节)'}`;
    case RUN_STATUS.OUTPUT_VIOLATES_CONTRACT:
      return `上游节点 ${result.upstream ?? '?'} 的产出不满足出边契约，重试预算已用尽：${errs(blocked.errors) || '(无细节)'}`;
case RUN_STATUS.BUDGET_EXCEEDED:
      return `预算用尽，在节点 ${result.stoppedAt ?? '?'} 之前中止：已用 ${String(result.elapsedMs ?? '?')}ms，上限 ${String(result.maxWallClockMs ?? '?')}ms`;
    case RUN_STATUS.NODE_FAILED:
      return `节点 ${result.upstream ?? '?'} 执行失败：${result.error ?? '(无细节)'}`;
    default:
      return `未知状态 ${String(result.status)}`;
  }
}
