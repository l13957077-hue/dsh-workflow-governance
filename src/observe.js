/**
 * Observation → run record → graph projection + stall detection, for the
 * OFFICIAL `workflow/*` vocabulary (see docs/workflow-mode/OFFICIAL-SEAM.md).
 *
 * A vocabulary gap this module exists to work around, verified against the
 * installed seam: the 6 events expose only RUNNING (after agent-start) and the
 * three terminal outcomes (agent-end). There is NO `BLOCKED` state. So the
 * requirement's literal deadlock rule — "every unfinished node is BLOCKED and
 * nothing is running" — is NOT expressible from these events. The faithful
 * equivalent is time-based: started, not ended, nothing running, no progress for
 * longer than a threshold.
 *
 *   detectStall      time-based    ← correct instrument for workflow/* events
 *   detectDeadlock   status-based  ← for sources that DO expose BLOCKED (a
 *                                    declarative DAG plugin's graph)
 *
 * Note on edges: `workflow/*` carries no dependency structure. `projectGraph`
 * therefore INFERS edges from phase order, marks them as inferred, and lets the
 * caller pick another policy. Phase membership itself is real (it is on the
 * agent payload), and agents sharing a phase are treated as independent — which
 * matches `parallel()`.
 */

export const AGENT_STATUS = Object.freeze({
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const OUTCOME_TO_STATUS = Object.freeze({
  completed: AGENT_STATUS.DONE,
  failed: AGENT_STATUS.FAILED,
  cancelled: AGENT_STATUS.CANCELLED,
});

export const EDGE_POLICY = Object.freeze({
  PHASE_CHAIN: 'phase-chain',
  NONE: 'none',
});

const DEFAULTS = Object.freeze({ maxLogs: 500 });

export function createRunObserver({ maxLogs = DEFAULTS.maxLogs } = {}) {
  if (!Number.isInteger(maxLogs) || maxLogs < 0) throw new RangeError('maxLogs must be an integer >= 0');
  const runs = new Map();

  function record(runId) {
    return runs.get(runId) ?? null;
  }

  return {
    observe(observation) {
      const event = observation?.event;
      const info = observation?.info;
      const args = Array.isArray(observation?.args) ? observation.args : [];
      const id = info?.id;
      if (typeof id !== 'string' || id === '') return null;

      let rec = runs.get(id);
      const at = observation.at ?? Date.now();

      if (event === 'workflow/start') {
        if (rec) {
          // The host invariant rejects a repeated run id; be defensive, never crash.
          rec.anomalies.push('REPEATED_START');
          return rec;
        }
        rec = {
          id,
          meta: info?.meta ?? null,
          startedAt: at,
          lastActivityAt: at,
          endedAt: null,
          result: null,
          phases: [],
          agents: new Map(),
          openSeqs: new Set(),
          logs: [],
          counters: { agentStarts: 0, agentEnds: 0, phases: 0, logs: 0, unrecognized: 0 },
          anomalies: [],
        };
        runs.set(id, rec);
        return rec;
      }

      // An event for a run we never saw a start for is not ours to project.
      if (!rec) return null;
      rec.lastActivityAt = at;

      switch (event) {
        case 'workflow/phase': {
          const title = typeof args[0] === 'string' ? args[0] : null;
          if (title !== null && !rec.phases.includes(title)) rec.phases.push(title);
          rec.counters.phases += 1;
          break;
        }
        case 'workflow/log': {
          const message = typeof args[0] === 'string' ? args[0] : String(args[0]);
          if (maxLogs > 0) {
            rec.logs.push({ at, message });
            if (rec.logs.length > maxLogs) rec.logs.splice(0, rec.logs.length - maxLogs);
          }
          rec.counters.logs += 1;
          break;
        }
        case 'workflow/agent-start': {
          const agent = args[0];
          if (!agent || !Number.isSafeInteger(agent.seq) || agent.seq < 1) {
            rec.anomalies.push('AGENT_START_BAD_SEQ');
            break;
          }
          if (rec.agents.has(agent.seq)) {
            rec.anomalies.push(`REPEATED_AGENT_SEQ:${agent.seq}`);
            break;
          }
          rec.agents.set(agent.seq, {
            seq: agent.seq,
            childId: typeof agent.childId === 'string' && agent.childId !== '' ? agent.childId : `seq-${agent.seq}`,
            label: agent.label ?? null,
            phase: agent.phase ?? null,
            status: AGENT_STATUS.RUNNING,
            startedAt: at,
            endedAt: null,
            outcome: null,
          });
          rec.openSeqs.add(agent.seq);
          rec.counters.agentStarts += 1;
          break;
        }
        case 'workflow/agent-end': {
          const agent = args[0];
          if (!agent || !Number.isSafeInteger(agent.seq)) {
            rec.anomalies.push('AGENT_END_BAD_SEQ');
            break;
          }
          const existing = rec.agents.get(agent.seq);
          if (!existing) {
            rec.anomalies.push(`UNPAIRED_AGENT_END:${agent.seq}`);
            break;
          }
          existing.status = OUTCOME_TO_STATUS[agent.outcome] ?? AGENT_STATUS.FAILED;
          if (!OUTCOME_TO_STATUS[agent.outcome]) rec.anomalies.push(`UNKNOWN_OUTCOME:${String(agent.outcome)}`);
          existing.outcome = agent.outcome ?? null;
          existing.endedAt = at;
          rec.openSeqs.delete(agent.seq);
          rec.counters.agentEnds += 1;
          break;
        }
        case 'workflow/end': {
          rec.endedAt = at;
          rec.result = args[0] ?? null;
          if (rec.openSeqs.size > 0) rec.anomalies.push('OPEN_AGENTS_AT_END');
          break;
        }
        default:
          rec.counters.unrecognized += 1;
      }
      return rec;
    },

    record,
    records() {
      return [...runs.values()];
    },

    reset() {
      runs.clear();
    },
  };
}

/**
 * Project a run record into the `{nodes, edges}` shape `detectDeadlock` consumes.
 * Edges are INFERRED unless the source provides them; `edgesSource` says so.
 */
export function projectGraph(record, { edgePolicy = EDGE_POLICY.PHASE_CHAIN } = {}) {
  if (!record || !(record.agents instanceof Map)) {
    return { nodes: [], edges: [], edgesSource: 'none', phases: [] };
  }
  const seen = new Set();
  const nodes = [];
  const byPhase = new Map();
  for (const agent of [...record.agents.values()].sort((a, b) => a.seq - b.seq)) {
    let id = agent.childId;
    if (seen.has(id)) id = `${agent.childId}#${agent.seq}`;
    seen.add(id);
    nodes.push({ id, status: agent.status, phase: agent.phase ?? null, seq: agent.seq });
    const key = agent.phase ?? '';
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key).push(id);
  }

  if (edgePolicy === EDGE_POLICY.NONE) {
    return { nodes, edges: [], edgesSource: 'none', phases: [...record.phases] };
  }
  if (edgePolicy !== EDGE_POLICY.PHASE_CHAIN) {
    throw new RangeError(`unknown edgePolicy: ${String(edgePolicy)}`);
  }

  const order = [...byPhase.keys()];
  const edges = [];
  for (let i = 0; i + 1 < order.length; i += 1) {
    for (const from of byPhase.get(order[i])) {
      for (const to of byPhase.get(order[i + 1])) edges.push({ from, to });
    }
  }
  return { nodes, edges, edgesSource: 'inferred:phase-order', phases: [...record.phases] };
}

export const STALL_REASON = Object.freeze({
  NO_RECORD: 'NO-RECORD',
  ENDED: 'ENDED',
  PROGRESSING: 'PROGRESSING',
  RUNNING_AGENT_SILENT: 'RUNNING-AGENT-SILENT',
  OPEN_AGENTS_NO_PROGRESS: 'OPEN-AGENTS-NO-PROGRESS',
  NO_ACTIVITY: 'NO-ACTIVITY',
});

/**
 * The instrument that fits the official vocabulary.
 *
 * Staleness is measured by SILENCE, not by the running flag: an agent that is
 * nominally RUNNING but has produced no progress event for longer than
 * idleTimeoutMs is exactly the hang we care about, because the official run has
 * no overall elapsed-time deadline (`timeoutMs: null`) and the `workflow` tool
 * blocks the parent turn until settlement. A `running > 0` short-circuit would
 * therefore make this detector blind to its own main case.
 */
export function detectStall(record, { now = Date.now(), idleTimeoutMs = 60_000 } = {}) {
  if (typeof idleTimeoutMs !== 'number' || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new RangeError('idleTimeoutMs must be a finite number >= 0');
  }
  if (!record) return { stalled: false, reason: STALL_REASON.NO_RECORD, idleMs: 0, running: 0, open: 0 };
  const agents = record.agents instanceof Map ? [...record.agents.values()] : [];
  const running = agents.filter((a) => a.status === AGENT_STATUS.RUNNING).length;
  const open = record.openSeqs instanceof Set ? record.openSeqs.size : 0;
  // Clock skew must not manufacture a stall.
  const idleMs = Math.max(0, now - (record.lastActivityAt ?? now));
  const base = { idleMs, running, open };

  if (record.endedAt) return { stalled: false, reason: STALL_REASON.ENDED, ...base };
  if (idleMs < idleTimeoutMs) return { stalled: false, reason: STALL_REASON.PROGRESSING, ...base };
  const reason =
    running > 0
      ? STALL_REASON.RUNNING_AGENT_SILENT
      : open > 0
        ? STALL_REASON.OPEN_AGENTS_NO_PROGRESS
        : STALL_REASON.NO_ACTIVITY;
  return { stalled: true, reason, ...base };
}

export function explainStall(record, stall) {
  const name = record?.meta?.name ?? record?.id ?? '(unknown run)';
  const secs = Math.round((stall?.idleMs ?? 0) / 1000);
  switch (stall?.reason) {
    case STALL_REASON.ENDED:
      return `运行 ${name} 已结算。`;
    case STALL_REASON.PROGRESSING:
      return `运行 ${name} 最近有进度（静默 ${secs}s，未超阈值）。`;
    case STALL_REASON.RUNNING_AGENT_SILENT:
      return `运行 ${name} 停滞：${stall.running} 个子代理在运行但已静默 ${secs}s。官方运行为 timeoutMs=null（无整体时间截止）且 workflow 工具会阻塞父级轮次，需挂起转人工。`;
    case STALL_REASON.OPEN_AGENTS_NO_PROGRESS:
      return `运行 ${name} 停滞：${stall.open} 个子代理已启动未结束、且无运行中节点，已静默 ${secs}s。`;
    case STALL_REASON.NO_ACTIVITY:
      return `运行 ${name} 停滞：已启动但未结算，无运行中子代理，已静默 ${secs}s。`;
    default:
      return `运行 ${name} 无观测记录。`;
  }
}
