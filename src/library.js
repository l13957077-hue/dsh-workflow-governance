/**
 * G1: the saved-workflow library (R11 / R12 / R14 / R15).
 *
 * Why this exists: the installed DSH 0.2.0 bundle has NO saved-workflow concept.
 * A provenance scan of app.asar found `workflow_list`, `workflow_manage`,
 * `rename-saved`, `delete-saved`, `resume-run` and `run_workflow` all ABSENT, so
 * the saved-workflow surface seen once during development came from community
 * plugins that were removed for incompatibility. Nothing official replaces it.
 *
 * This is a plain filesystem-backed store. It is deliberately NOT a service and
 * NOT a global: the caller passes `root`, so the layer never invents a location.
 *
 * Fail-closed on save, for the same reason `contract.js` refuses unsupported
 * keywords: a saved workflow is a promise that its contracts will be enforced
 * later. Saving one we could not enforce would turn a written guarantee into a
 * silent no-op. `validateWorkflow` also rejects cycles and dangling edges, so a
 * broken graph cannot enter the library at all.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkflow } from './contract.js';
import { selectTemplate } from './matcher.js';

const FILE = 'library.json';
const MAX_NAME_CODEPOINTS = 64;
const MAX_DEFINITION_BYTES = 512 * 1024;

/**
 * Names are JSON keys inside one file, never filenames -- the store is
 * deliberately single-file so a name can never become a path. That is why this
 * allows any printable character, including CJK: restricting names to ASCII
 * would buy no safety and would stop an operator naming a workflow in their own
 * language. Only genuinely ambiguous or dangerous names are refused.
 */
function assertName(name, label = 'name') {
  if (typeof name !== 'string') throw new TypeError(`${label} must be a string (got ${typeof name})`);
  if (!NAME_OK.test(name)) throw new TypeError(`${label} is not usable: ${JSON.stringify(name)}`);
  if ([...name].length > MAX_NAME_CODEPOINTS) {
    throw new TypeError(`${label} is longer than ${MAX_NAME_CODEPOINTS} characters`);
  }
}

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const NAME_OK = /^(?!\.{1,2}$)(?!\s)(?![\s\S]*\s$)[^\u0000-\u001F\u007F]+$/;

function emptyLibrary() {
  return { version: 1, entries: {} };
}

function readLibrary(file) {
  if (!existsSync(file)) return emptyLibrary();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // A corrupt library must not be silently treated as empty and then
    // overwritten on the next save -- that would destroy the operator's data.
    throw new Error(`template library at ${file} is not valid JSON; refusing to touch it`);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error(`template library at ${file} has an unexpected shape; refusing to touch it`);
  }
  return parsed;
}

/** Atomic: a crash mid-write must never leave a half-written library. */
function writeLibrary(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** Summaries only: listing 200 workflows must not carry 200 full graphs. */
function summarize(entry) {
  return {
    name: entry.name,
    description: entry.description ?? null,
    labels: Array.isArray(entry.labels) ? [...entry.labels] : [],
    revision: entry.revision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    nodes: Array.isArray(entry.nodes) ? entry.nodes.length : 0,
    edges: Array.isArray(entry.edges) ? entry.edges.length : 0,
    stats: {
      runs: entry.stats?.runs ?? 0,
      successes: entry.stats?.successes ?? 0,
      scoreSum: entry.stats?.scoreSum ?? 0,
      scoredRuns: entry.stats?.scoredRuns ?? 0,
    },
    // Count only: the instances themselves stay in `get()`, so `list()` stays light.
    uses: Array.isArray(entry.history) ? entry.history.length : 0,
  };
}

export function createTemplateLibrary({ root, now = Date.now } = {}) {
  if (typeof root !== 'string' || root === '') throw new TypeError('root must be a non-empty string');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const file = join(root, FILE);

  const load = () => readLibrary(file);
  const commit = (data) => {
    mkdirSync(root, { recursive: true });
    writeLibrary(file, data);
    return data;
  };

  const api = {
    /** Path of the backing file, so an operator can back it up. */
    path: file,

    list() {
      const data = load();
      return Object.values(data.entries)
        .map(summarize)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    has(name) {
      assertName(name);
      return Object.prototype.hasOwnProperty.call(load().entries, name);
    },

    get(name) {
      assertName(name);
      const entry = load().entries[name];
      return entry ? JSON.parse(JSON.stringify(entry)) : null;
    },

    /**
     * Create or replace a definition. `revision` bumps on replace, so a caller
     * can tell "same name, different graph" from an idempotent re-save.
     */
    save(definition) {
      const def = definition ?? {};
      const name = def.name;
      assertName(name);

      const problems = [];
      if (typeof def.description === 'string' && def.description.length > 500) {
        problems.push({ path: '#/description', keyword: 'maxLength', message: 'description is limited to 500 characters' });
      }
      if (def.labels !== undefined && (!Array.isArray(def.labels) || def.labels.some((l) => typeof l !== 'string'))) {
        problems.push({ path: '#/labels', keyword: 'labels', message: 'labels must be an array of strings' });
      }
      const asJson = JSON.stringify({ nodes: def.nodes, edges: def.edges });
      if (asJson.length > MAX_DEFINITION_BYTES) {
        problems.push({ path: '#', keyword: 'maxSize', message: `definition exceeds ${MAX_DEFINITION_BYTES} bytes` });
      }
      if (problems.length > 0) return { ok: false, code: 'INVALID_DEFINITION', problems };

      // The fail-closed gate: unsupported contracts and broken graphs cannot
      // be saved, because a saved workflow is treated as enforceable promise.
      const graph = validateWorkflow({ nodes: def.nodes, edges: def.edges });
      if (!graph.ok) return { ok: false, code: 'INVALID_WORKFLOW', problems: graph.problems };

      const data = load();
      const previous = data.entries[name];
      const at = now();
      const entry = {
        name,
        description: typeof def.description === 'string' ? def.description : null,
        labels: Array.isArray(def.labels) ? def.labels.map((l) => String(l)) : [],
        nodes: def.nodes,
        edges: def.edges,
        revision: previous ? previous.revision + 1 : 1,
        createdAt: previous ? previous.createdAt : at,
        updatedAt: at,
        stats: previous ? previous.stats : { runs: 0, successes: 0 },
      };
      data.entries[name] = entry;
      commit(data);
      return { ok: true, code: previous ? 'REPLACED' : 'CREATED', entry: summarize(entry) };
    },

    rename(from, to) {
      assertName(from, 'from');
      assertName(to, 'to');
      const data = load();
      const entry = data.entries[from];
      if (!entry) return { ok: false, code: 'NOT_FOUND', name: from };
      if (data.entries[to]) return { ok: false, code: 'NAME_TAKEN', name: to };
      delete data.entries[from];
      entry.name = to;
      entry.updatedAt = now();
      data.entries[to] = entry;
      commit(data);
      return { ok: true, code: 'RENAMED', from, to, entry: summarize(entry) };
    },

    remove(name) {
      assertName(name);
      const data = load();
      if (!data.entries[name]) return { ok: false, code: 'NOT_FOUND', name };
      delete data.entries[name];
      commit(data);
      return { ok: true, code: 'REMOVED', name };
    },

    /** Feed matcher.js so a run can tell whether to re-save or reuse. */
    recordRun(name, { success, score, context } = {}) {
      assertName(name);
      const data = load();
      const entry = data.entries[name];
      if (!entry) return { ok: false, code: 'NOT_FOUND', name };
      entry.stats = entry.stats ?? { runs: 0, successes: 0 };
      entry.stats.runs += 1;
      if (success === true) entry.stats.successes += 1;
      // An automatic per-run score, so an operator never rates a run by hand: the run
      // itself reports how cleanly it executed (retries, contract violations). Stored as
      // a sum plus a count, so the average survives without keeping an unbounded history.
      if (Number.isFinite(score)) {
        entry.stats.scoreSum = Number(entry.stats.scoreSum ?? 0) + Number(score);
        entry.stats.scoredRuns = Number(entry.stats.scoredRuns ?? 0) + 1;
      }
      /**
       * Every use is its own instance, kept with the context that makes it findable again
       * later: when it ran, which session and agent ran it, and which subagents did the
       * steps. Bounded and newest-first -- this is for tracing a use, not an audit log,
       * and an unbounded array would grow inside the library file forever.
       *
       * A field that is unknown stays null: a session title is never invented here.
       */
      const instance = {
        at: Number.isFinite(context?.at) ? context.at : now(),
        ok: success === true,
        score: Number.isFinite(score) ? Number(score) : null,
        sessionId: context?.sessionId ?? null,
        sessionTitle: context?.sessionTitle ?? null,
        agentId: context?.agentId ?? null,
        nodes: Array.isArray(context?.nodes) ? context.nodes : [],
        subagents: Array.isArray(context?.subagents) ? context.subagents : [],
      };
      entry.history = Array.isArray(entry.history) ? entry.history : [];
      entry.history.unshift(instance);
      if (entry.history.length > 25) entry.history.length = 25;
      entry.updatedAt = now();
      commit(data);
      return { ok: true, code: 'RECORDED', stats: { ...entry.stats } };
    },

    /**
     * R12/R14: pick a stored workflow for this task. Delegates the scoring to
     * matcher.js and returns its reuse / ask / create decision unchanged.
     *
     * The summaries are re-keyed to the shape matcher.js expects (`id`), because
     * the store keys entries by `name` while the scorer works on `id`. Mapping
     * this wrong is silent: the score still comes back, but `best.id` is
     * undefined and a reuse decision cannot be acted on.
     */
    find(query, options = {}) {
      const templates = api.list().map((row) => ({
        id: row.name,
        name: row.name,
        description: row.description,
        labels: row.labels,
        stats: row.stats,
      }));
      return selectTemplate(query, templates, options);
    },

    exportOne(name) {
      assertName(name);
      const entry = api.get(name);
      if (!entry) return { ok: false, code: 'NOT_FOUND', name };
      return { ok: true, code: 'EXPORTED', json: `${JSON.stringify(entry, null, 2)}\n` };
    },

    /**
     * Import goes through save(), so an imported graph is validated exactly like
     * an authored one. Import data comes from outside, so every rejection is a
     * RETURNED refusal -- an exception here would escape into a host tool call.
     */
    importOne(json) {
      let parsed;
      try {
        parsed = typeof json === 'string' ? JSON.parse(json) : json;
      } catch (error) {
        return { ok: false, code: 'INVALID_JSON', problems: [{ path: '#', keyword: 'json', message: String(error && error.message ? error.message : error) }] };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, code: 'INVALID_JSON', problems: [{ path: '#', keyword: 'json', message: 'an import must be a JSON object' }] };
      }
      try {
        return api.save(parsed);
      } catch (error) {
        return {
          ok: false,
          code: 'INVALID_DEFINITION',
          problems: [{ path: '#/name', keyword: 'name', message: String(error && error.message ? error.message : error) }],
        };
      }
    },

    /** Whole-library export for backup. */
    exportAll() {
      return { ok: true, code: 'EXPORTED', json: `${JSON.stringify(load(), null, 2)}\n` };
    },

    /** Dangerous by intent, so it is explicit and never implicit. */
    destroy() {
      if (!existsSync(file)) return { ok: true, code: 'ABSENT' };
      rmSync(file);
      return { ok: true, code: 'DESTROYED', path: file };
    },
  };

  return api;
}
