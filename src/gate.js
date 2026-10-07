/**
 * R9/R10 dynamic capability authorization (host side).
 *
 * R9: an unassigned capability stays visible but not usable.
 * R10: using it requires a reasoned request that the main agent adjudicates;
 *      approval is allowed-once and time-boxed by default.
 *
 * Every path is fail-closed: an unknown agent, an expired or already-spent
 * grant, a missing reason, or the feature switch being off all deny.
 */

export const DENY = Object.freeze({
  SWITCH_DISABLED: 'SWITCH_DISABLED',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  UNKNOWN_REQUEST: 'UNKNOWN_REQUEST',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
  NOT_ASSIGNED: 'NOT_ASSIGNED',
  REASON_REQUIRED: 'REASON_REQUIRED',
  NO_APPROVED_REQUEST: 'NO_APPROVED_REQUEST',
  REQUEST_DENIED: 'REQUEST_DENIED',
  EXPIRED: 'EXPIRED',
  CONSUMED: 'CONSUMED',
});

export const GRANT = Object.freeze({
  ASSIGNED: 'ASSIGNED',
  GRANTED: 'GRANTED',
  NATIVE: 'NATIVE',
});

const REQUEST_PENDING = 'pending';
const REQUEST_APPROVED = 'approved';
const REQUEST_DENIED = 'denied';

function blank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

export class CapabilityGate {
  #assignments = new Map();
  #catalog = new Set();
  #requests = new Map();
  #grants = new Map();
  #audit = [];
  #seq = 0;
  #enabled;
  #now;
  #ttlMs;
  #allowOnce;

  constructor({ enabled = false, now = () => Date.now(), ttlMs = 300_000, allowOnce = true } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError('ttlMs must be a finite number >= 0');
    this.#enabled = enabled === true;
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#allowOnce = allowOnce === true;
  }

  get enabled() {
    return this.#enabled;
  }

  /** Runtime toggle for fast degradation. Turning it off denies every unassigned use. */
  setEnabled(value) {
    this.#enabled = value === true;
    this.#record('switch', { enabled: this.#enabled });
    return this.#enabled;
  }

  registerCapabilities(list) {
    for (const cap of Array.isArray(list) ? list : []) {
      if (blank(cap)) throw new TypeError('capability must be a non-empty string');
      this.#catalog.add(cap);
    }
    return this.#catalog.size;
  }

  /** Replace one agent's assigned set. */
  assign(agentId, capabilities) {
    if (blank(agentId)) throw new TypeError('agentId must be a non-empty string');
    const set = new Set((Array.isArray(capabilities) ? capabilities : []).filter((c) => !blank(c)));
    this.#assignments.set(agentId, set);
    this.#record('assign', { agentId, capabilities: [...set] });
    return set;
  }

  /**
   * Register an agent it has not seen, granting nothing.
   *
   * `requestAccess` refuses an unknown agent, so a caller has to be known before
   * it can ask. This is deliberately NOT `assign(agentId, [])`: `assign` REPLACES
   * a set, and `assigned()` cannot tell "unknown" from "known with nothing", so
   * using it here would silently wipe the assignments of an agent that holds some
   * other capability. That is the whole reason this method exists.
   *
   * @returns true when the agent was newly registered.
   */
  ensureKnown(agentId) {
    if (blank(agentId)) throw new TypeError('agentId must be a non-empty string');
    if (this.#assignments.has(agentId)) return false;
    this.#assignments.set(agentId, new Set());
    this.#record('register', { agentId, capabilities: [] });
    return true;
  }

  assigned(agentId) {
    return new Set(this.#assignments.get(agentId) ?? []);
  }

  /** R9: list what this agent can see, and mark what it may actually use. */
  visible(agentId) {
    if (blank(agentId)) throw new TypeError('agentId must be a non-empty string');
    const owned = this.assigned(agentId);
    return [...this.#catalog].sort().map((capability) => ({
      capability,
      assigned: owned.has(capability),
      usable: this.canUse(agentId, capability),
    }));
  }

  /**
   * Non-consuming probe: does this agent hold a usable path right now?
   * Reporting surfaces must use this, because authorize() spends a one-shot grant.
   * When the layer is disabled it defers, exactly like authorize().
   */
  canUse(agentId, capability) {
    if (blank(agentId)) throw new TypeError('agentId must be a non-empty string');
    if (blank(capability)) throw new TypeError('capability must be a non-empty string');
    if (!this.#enabled) return true;
    if (this.assigned(agentId).has(capability)) return true;
    return [...this.#grants.values()].some(
      (g) => g.agentId === agentId && g.capability === capability && !g.consumed && g.expiresAt > this.#now(),
    );
  }

  requestAccess(agentId, capability, reason) {
    if (blank(agentId)) throw new TypeError('agentId must be a non-empty string');
    if (blank(capability)) throw new TypeError('capability must be a non-empty string');

    if (!this.#enabled) return this.#refuse('requestAccess', { agentId, capability }, DENY.SWITCH_DISABLED);
    if (!this.#assignments.has(agentId)) return this.#refuse('requestAccess', { agentId, capability }, DENY.UNKNOWN_AGENT);
    if (!this.#catalog.has(capability)) return this.#refuse('requestAccess', { agentId, capability }, DENY.UNKNOWN_CAPABILITY);
    if (this.assigned(agentId).has(capability)) {
      this.#record('requestAccess', { agentId, capability, outcome: 'not-needed' });
      return { ok: true, status: 'not-needed', code: GRANT.ASSIGNED };
    }
    if (blank(reason)) return this.#refuse('requestAccess', { agentId, capability }, DENY.REASON_REQUIRED);

    this.#seq += 1;
    const request = {
      id: `req-${this.#seq}`,
      agentId,
      capability,
      reason: reason.trim(),
      status: REQUEST_PENDING,
      createdAt: this.#now(),
      decidedAt: null,
      decidedBy: null,
    };
    this.#requests.set(request.id, request);
    this.#record('requestAccess', { agentId, capability, requestId: request.id, outcome: 'pending' });
    return { ok: true, request: { ...request } };
  }

  decide(requestId, { approve = false, by = 'main-agent', ttlMs, note } = {}) {
    if (blank(requestId)) throw new TypeError('requestId must be a non-empty string');
    if (!this.#enabled) return this.#refuse('decide', { requestId }, DENY.SWITCH_DISABLED);
    const request = this.#requests.get(requestId);
    if (!request) return this.#refuse('decide', { requestId }, DENY.UNKNOWN_REQUEST);
    if (request.status !== REQUEST_PENDING) {
      this.#record('decide', { requestId, outcome: 'already-decided', status: request.status });
      return { ok: false, code: 'ALREADY_DECIDED', status: request.status };
    }
    request.decidedAt = this.#now();
    request.decidedBy = by;
    request.note = note ?? null;

    if (approve !== true) {
      request.status = REQUEST_DENIED;
      this.#record('decide', { requestId, outcome: 'denied', by });
      return { ok: true, status: REQUEST_DENIED, request: { ...request } };
    }

    request.status = REQUEST_APPROVED;
    const ttl = ttlMs === undefined ? this.#ttlMs : ttlMs;
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0) throw new RangeError('ttlMs must be a finite number >= 0');
    this.#seq += 1;
    const grant = {
      id: `grant-${this.#seq}`,
      requestId,
      agentId: request.agentId,
      capability: request.capability,
      issuedAt: this.#now(),
      expiresAt: this.#now() + ttl,
      allowOnce: this.#allowOnce,
      consumed: false,
    };
    this.#grants.set(grant.id, grant);
    this.#record('decide', { requestId, outcome: 'approved', by, grantId: grant.id, ttlMs: ttl });
    return { ok: true, status: REQUEST_APPROVED, request: { ...request }, grant: { ...grant } };
  }

  /**
   * The single enforcement point. With the layer disabled it delegates
   * (GRANT.NATIVE) so the plugin's own assignment rules stay authoritative and
   * this layer can never add a denial to the native path.
   */
  authorize(agentId, capability) {
    if (blank(agentId)) throw new TypeError('agentId must be a non-empty string');
    if (blank(capability)) throw new TypeError('capability must be a non-empty string');

    if (!this.#enabled) return { allowed: true, code: GRANT.NATIVE, delegated: true };
    if (this.assigned(agentId).has(capability)) return { allowed: true, code: GRANT.ASSIGNED };

    const related = [...this.#grants.values()].filter((g) => g.agentId === agentId && g.capability === capability);
    const usable = related.find((g) => !g.consumed && g.expiresAt > this.#now());
    if (usable) {
      if (usable.allowOnce) usable.consumed = true;
      this.#record('authorize', { agentId, capability, outcome: 'granted', grantId: usable.id });
      return { allowed: true, code: GRANT.GRANTED, grantId: usable.id };
    }

    let code = DENY.NOT_ASSIGNED;
    if (related.some((g) => g.consumed)) code = DENY.CONSUMED;
    else if (related.length > 0) code = DENY.EXPIRED;
    else {
      const req = [...this.#requests.values()].find((r) => r.agentId === agentId && r.capability === capability);
      if (req?.status === REQUEST_DENIED) code = DENY.REQUEST_DENIED;
      else if (req?.status === REQUEST_PENDING) code = DENY.NO_APPROVED_REQUEST;
    }
    this.#record('authorize', { agentId, capability, outcome: 'denied', code });
    return { allowed: false, code };
  }

  audit() {
    return this.#audit.map((e) => ({ ...e, detail: { ...e.detail } }));
  }

  #refuse(event, detail, code) {
    this.#record(event, { ...detail, outcome: 'refused', code });
    return { ok: false, code };
  }

  #record(event, detail) {
    this.#audit.push({ seq: this.#audit.length + 1, at: this.#now(), event, detail });
  }
}
