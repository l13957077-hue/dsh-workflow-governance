/**
 * Concrete adapter over the OFFICIAL workflow seam, `ctx.workflowEngine`.
 *
 * Signature source: docs/workflow-mode/OFFICIAL-SEAM.md, extracted from the
 * installed host (DSH Desktop, all @deepseek-ai/* at 0.2.0-rc.2).
 *
 * What this adds, and deliberately does NOT add:
 *   + an own-run registry, because the seam is holder-owned and the service
 *     tracks nothing. We only ever track runs WE started.
 *   + observation fan-out over the 6-event observe-only vocabulary.
 *   + a settle() that always disposes.
 *   - it does NOT re-validate scripts or meta: `engine.start()` already
 *     validates before publishing and throws a violation list. Re-checking
 *     would duplicate the host.
 *   - it does NOT derive cancel/dispose authority from events. The seam's whole
 *     point is that payloads carry an identity snapshot, never a live run, so a
 *     listener cannot obtain control. Nothing here accepts a payload as proof.
 */

/** The frozen vocabulary. Order is the lifecycle order. */
export const WORKFLOW_EVENTS = Object.freeze([
  'workflow/start',
  'workflow/phase',
  'workflow/log',
  'workflow/agent-start',
  'workflow/agent-end',
  'workflow/end',
]);

const DEFAULTS = Object.freeze({ maxEvents: 2000 });

export class WorkflowEngineAdapter {
  #engine;
  #ctx;
  #now;
  #maxEvents;
  #runs = new Map();
  #observers = new Set();
  #events = [];
  #detach = null;
  #adopting = null;
  #observerErrors = 0;

  /**
   * `engine` is OPTIONAL, because observation does not need it.
   *
   * This adapter has two halves that the host keeps apart:
   *   - OBSERVATION: `attach()` subscribes with `{ global: true }` to the six
   *     `workflow/*` events. It never touches the engine.
   *   - CONTROL: `start()`, which calls `engine.start(...)`.
   * Requiring an engine therefore made observation impossible in a composition
   * where the engine is isolated away from this plugin -- which is exactly the
   * shipped shape (`isolate: { workflowEngine: true }` on the `delegation` group).
   * A caller that only observes may pass `engine: null`; a caller that reaches for
   * control without one gets a message naming what is missing.
   */
  constructor({ engine = null, ctx, now = () => Date.now(), maxEvents = DEFAULTS.maxEvents } = {}) {
    if (engine !== null && engine !== undefined && typeof engine.start !== 'function') {
      throw new TypeError('engine must be ctx.workflowEngine (an object exposing start()), or null to observe only');
    }
    if (!ctx || typeof ctx.on !== 'function') throw new TypeError('ctx must expose on(name, fn, options)');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new RangeError('maxEvents must be an integer >= 1');
    this.#engine = engine ?? null;
    this.#ctx = ctx;
    this.#now = now;
    this.#maxEvents = maxEvents;
  }

  /** True when this instance also holds the control seam. */
  get controllable() {
    return this.#engine !== null;
  }

  get observerErrors() {
    return this.#observerErrors;
  }

  get attached() {
    return this.#detach !== null;
  }

  /**
   * Subscribe the 6 observe-only events. Idempotent: a second call returns the
   * same disposer and does not double-subscribe.
   * @returns {() => void} detach
   */
  attach() {
    if (this.#detach) return this.#detach;
    const offs = WORKFLOW_EVENTS.map((name) =>
      this.#ctx.on(name, (info, ...args) => this.#handle(name, info, args), { global: true }),
    );
    const detach = () => {
      if (!this.#detach) return;
      this.#detach = null;
      for (const off of offs) if (typeof off === 'function') off();
    };
    this.#detach = detach;
    return detach;
  }

  /**
   * Start a run through the seam.
   *
   * `start()` validates before the run exists and throws synchronously, so this
   * propagates whatever the engine throws, unchanged. Nothing is registered when
   * it throws.
   *
   * The engine may publish `workflow/start` synchronously *inside* start(),
   * before we hold the handle, so we adopt the first run id seen during the call.
   * The returned handle's id stays authoritative.
   *
   * @param {{script: string, meta: object, args?: object, parent?: unknown, signal?: unknown, root?: boolean}} request
   * @returns {{runId: string, run: object}}
   */
  start(request = {}) {
    if (this.#engine === null) {
      throw new Error('no workflowEngine is visible to this plugin, so the control seam is unavailable (this instance observes only)');
    }
    const pending = { root: request.root !== false, startedAt: this.#now(), handle: null, meta: request.meta ?? null };
    this.#adopting = pending;
    let run;
    try {
      run = this.#engine.start(request);
    } finally {
      this.#adopting = null;
    }
    if (!run || typeof run !== 'object' || run.id === undefined || run.id === null) {
      throw new TypeError('engine.start() returned no run handle');
    }
    const record = this.#runs.get(run.id) ?? this.#register(run.id, pending);
    record.handle = run;
    record.meta = run.meta ?? record.meta;
    return { runId: run.id, run };
  }

  get(runId) {
    return this.#runs.get(runId) ?? null;
  }

  /** Only OUR runs. Never a claim about other holders' runs. */
  runs() {
    return [...this.#runs.values()].map((r) => ({ id: r.id, root: r.root, startedAt: r.startedAt, settled: r.settled }));
  }

  /** Wait for the run's result, then ALWAYS dispose it (holder obligation). */
  async settle(runId) {
    const record = this.#runs.get(runId);
    if (!record || !record.handle) return { ok: false, code: 'NOT_OWNED' };
    try {
      const settled = await record.handle.result;
      record.settled = settled ?? null;
      return { ok: true, settled: record.settled };
    } catch (error) {
      // The seam promises result never rejects; be defensive without swallowing it silently.
      record.settled = { stopReason: 'error', error: String(error?.message ?? error) };
      return { ok: false, code: 'RESULT_REJECTED', settled: record.settled };
    } finally {
      try {
        await record.handle.dispose();
      } catch {
        // A dispose failure must not mask the settled result.
      }
    }
  }

  /**
   * Cancel one of OUR runs. An id we did not start is refused — control is never
   * taken from an event payload.
   */
  cancel(runId, reason) {
    const record = this.#runs.get(runId);
    if (!record || !record.handle) return { ok: false, code: 'NOT_OWNED' };
    if (typeof record.handle.cancel !== 'function') return { ok: false, code: 'CANCEL_UNSUPPORTED' };
    record.handle.cancel(reason);
    return { ok: true };
  }

  /** Dispose one of OUR runs. */
  dispose(runId) {
    const record = this.#runs.get(runId);
    if (!record || !record.handle) return { ok: false, code: 'NOT_OWNED' };
    if (typeof record.handle.dispose !== 'function') return { ok: false, code: 'DISPOSE_UNSUPPORTED' };
    record.handle.dispose();
    return { ok: true };
  }

  /** Register an observation callback. Throwing observers are isolated and counted. */
  onObservation(fn) {
    if (typeof fn !== 'function') throw new TypeError('observer must be a function');
    this.#observers.add(fn);
    return () => this.#observers.delete(fn);
  }

  /** Bounded ring of observed events, oldest first. */
  observedEvents() {
    return this.#events.map((e) => ({ ...e, args: [...e.args] }));
  }

  observe(event, info, args = []) {
    this.#handle(event, info, args);
  }

  #register(id, pending) {
    const record = { id, root: pending.root, startedAt: pending.startedAt, handle: null, meta: pending.meta ?? null, settled: null };
    this.#runs.set(id, record);
    return record;
  }

  #handle(event, info, args) {
    const id = info?.id;
    let owned = this.#runs.has(id);
    if (!owned && this.#adopting !== null && id !== undefined && id !== null) {
      // The engine published workflow/start during our own start() call.
      this.#register(id, this.#adopting);
      owned = true;
    }
    const observation = { event, info, args, owned, at: this.#now() };
    this.#events.push(observation);
    if (this.#events.length > this.#maxEvents) this.#events.splice(0, this.#events.length - this.#maxEvents);
    for (const fn of this.#observers) {
      try {
        fn(observation);
      } catch {
        this.#observerErrors += 1;
      }
    }
  }
}
