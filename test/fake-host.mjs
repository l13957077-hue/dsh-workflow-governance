/**
 * Minimal stand-in for the host's cordis context + workflow engine, built to the
 * contract in docs/workflow-mode/OFFICIAL-SEAM.md:
 *
 *   - start() validates BEFORE the run exists and throws synchronously
 *   - the returned run exposes { id, meta, result, cancel(reason), dispose() }
 *   - result never rejects; it settles to { stopReason, error?, agentsStarted }
 *   - workflow/start fires for a published run (optionally synchronously inside
 *     start(), which is the ordering the adapter must survive)
 *
 * It is a test double, not a simulator: it does not run scripts and does not
 * spawn subagents. Only the seam's shape and ordering are modelled.
 */

export const FAKE_EVENTS = Object.freeze([
  'workflow/start',
  'workflow/phase',
  'workflow/log',
  'workflow/agent-start',
  'workflow/agent-end',
  'workflow/end',
]);

export function createFakeHost({ emitStartSync = true, withTimer = false } = {}) {
  const listeners = new Map();
  const subscriptions = [];
  const logs = { info: [], warn: [] };
  const timers = [];

  const ctx = {
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
    },
    logs,
    on(name, fn, options) {
      subscriptions.push({ name, fn, options });
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => {
        listeners.get(name)?.delete(fn);
      };
    },
    emit(name, ...args) {
      const set = listeners.get(name);
      if (!set) return 0;
      for (const fn of [...set]) fn(...args);
      return set.size;
    },
    listenerCount(name) {
      return listeners.get(name)?.size ?? 0;
    },
    emitAnywhere(name, ...args) {
      // bypasses ownership: lets a test fire an event for a foreign run
      const set = listeners.get(name);
      for (const fn of [...(set ?? [])]) fn(...args);
    },
  };

  if (withTimer) {
    ctx.setInterval = (fn, ms) => {
      const handle = {
        fn,
        ms,
        cleared: false,
        clear() {
          this.cleared = true;
        },
      };
      timers.push(handle);
      return handle;
    };
    ctx.timers = timers;
  }

  let counter = 0;
  const runs = new Map();

  const engine = {
    starts: 0,
    start(request = {}) {
      const meta = request.meta;
      const violations = [];
      if (typeof request.script !== 'string' || request.script.trim() === '') violations.push('script is required');
      if (!meta || typeof meta !== 'object') violations.push('meta is required');
      else {
        if (typeof meta.name !== 'string' || meta.name === '') violations.push('meta.name must be non-empty');
        if (typeof meta.description !== 'string' || meta.description === '') violations.push('meta.description must be non-empty');
      }
      if (violations.length) {
        const err = new Error(`WorkflowError: invalid start request: ${violations.join('; ')}`);
        err.code = 'WORKFLOW_INVALID_REQUEST';
        err.violations = violations;
        throw err;
      }

      engine.starts += 1;
      counter += 1;
      const id = `run-${counter}`;
      let settleResult;
      const result = new Promise((resolve) => {
        settleResult = resolve;
      });

      const run = {
        id,
        meta,
        result,
        stopReason: null,
        cancelled: null,
        disposeCount: 0,
        agentsStarted: 0,
        openSeqs: new Set(),
        starts: new Map(),
        settledPayload: undefined,
      };

      run.cancel = (reason) => {
        if (run.stopReason !== null) return;
        run.cancelled = reason ?? 'cancelled';
        run.stopReason = 'cancelled';
        const payload = { stopReason: 'cancelled', error: String(run.cancelled), agentsStarted: run.agentsStarted };
        run.settledPayload = payload;
        ctx.emit('workflow/end', { id, meta }, payload);
        settleResult(payload);
      };
      run.dispose = () => {
        run.disposeCount += 1;
        return Promise.resolve();
      };

      // --- test-only controls -------------------------------------------------
      run.phase = (title) => ctx.emit('workflow/phase', { id, meta }, title);
      run.log = (message) => ctx.emit('workflow/log', { id, meta }, message);
      run.startAgent = (seq, opts = {}) => {
        const agent = {
          seq,
          childId: opts.childId ?? `child-${seq}`,
          label: opts.label ?? `agent-${seq}`,
          phase: opts.phase ?? null,
        };
        run.starts.set(seq, agent);
        run.openSeqs.add(seq);
        run.agentsStarted += 1;
        ctx.emit('workflow/agent-start', { id, meta }, agent);
        return agent;
      };
      run.endAgent = (seq, outcome = 'completed') => {
        const identity = run.starts.get(seq) ?? { seq, childId: `child-${seq}`, label: `agent-${seq}`, phase: null };
        run.openSeqs.delete(seq);
        ctx.emit('workflow/agent-end', { id, meta }, { ...identity, outcome });
      };
      /** Fire an arbitrary payload, to exercise malformed / foreign events. */
      run.emitRaw = (name, ...args) => ctx.emit(name, { id, meta }, ...args);
      run.finish = ({ stopReason = 'completed', error } = {}) => {
        run.stopReason = stopReason;
        const payload = { stopReason, agentsStarted: run.agentsStarted };
        if (error !== undefined) payload.error = error;
        run.settledPayload = payload;
        ctx.emit('workflow/end', { id, meta }, payload);
        settleResult(payload);
      };
      run.fail = (message) => run.finish({ stopReason: 'error', error: message });

      runs.set(id, run);
      if (emitStartSync) ctx.emit('workflow/start', { id, meta });
      return run;
    },
  };

  // In the real host the engine is a ctx service: ctx.workflowEngine.
  ctx.workflowEngine = engine;

  return { ctx, engine, runs, subscriptions, logs, timers };
}

export const goodRequest = () => ({
  script: 'const r = await parallel([() => agent("a"), () => agent("b")]); return { n: r.length };',
  meta: { name: 'parallel-investigation', description: 'fan out and collect', phases: ['collect', 'analyze'] },
});
