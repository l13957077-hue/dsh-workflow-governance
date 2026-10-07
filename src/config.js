import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * All switches default to false: the layer is inert until the operator turns a
 * specific feature on. Nothing here reads or writes DSH global state.
 */
export const DEFAULT_CONFIG = Object.freeze({
  switches: Object.freeze({
    workflowMode: false,
    deadlockDetector: false,
    semanticMatcher: false,
    capabilityGate: false,
    contracts: false,
    templateLibrary: false,
    /**
     * R11's other half: write a finished run -- its result, its topology and its
     * diagram -- to disk. Off by default like every other capability here, so
     * installing the layer still changes nothing until an operator asks for it.
     */
    resultArtifacts: false,
  }),
  matcher: Object.freeze({
    reuseThreshold: 0.8,
    askThreshold: 0.6,
    labelWeight: 0.5,
    embeddingWeight: 0.5,
    historyFloor: 0.5,
  }),
  deadlock: Object.freeze({
    scanIntervalMs: 30_000,
    idleTimeoutMs: 60_000,
    escalateAfter: 3,
  }),
  gate: Object.freeze({
    defaultTtlMs: 300_000,
    allowOnce: true,
  }),
  contracts: Object.freeze({
    maxAttemptsPerNode: 2,
    /**
     * Which `ctx.subagents` provider spawns a node. `spawn` is the provider the
     * shipped tool-subagent instances in this deployment are configured with
     * (`fork` is the other one).
     */
    provider: 'spawn',
  }),
  /**
   * G1 storage. `root` is relative to the plugin directory unless absolute, so
   * the layer never invents a machine-global location.
   */
  library: Object.freeze({
    root: 'library',
  }),
  /** R11: where finished runs are written. Relative to the plugin dir, like `library`. */
  artifacts: Object.freeze({
    root: 'results',
    maxFiles: 50,
  }),
});

const SECTIONS = ['switches', 'matcher', 'deadlock', 'gate', 'contracts', 'library', 'artifacts'];

export function defaultConfig() {
  const out = {};
  for (const s of SECTIONS) out[s] = { ...DEFAULT_CONFIG[s] };
  return out;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const RANGE = {
  'matcher.reuseThreshold': [0, 1],
  'matcher.askThreshold': [0, 1],
  'matcher.labelWeight': [0, 1],
  'matcher.embeddingWeight': [0, 1],
  'matcher.historyFloor': [0, 1],
  'deadlock.scanIntervalMs': [0, Number.MAX_SAFE_INTEGER],
  'deadlock.idleTimeoutMs': [0, Number.MAX_SAFE_INTEGER],
  'deadlock.escalateAfter': [1, 1000],
  'gate.defaultTtlMs': [0, Number.MAX_SAFE_INTEGER],
  'contracts.maxAttemptsPerNode': [1, 100],
  'artifacts.maxFiles': [0, 10_000],
};

/** Returns an array of problems; an empty array means the config is usable. */
export function validateConfig(cfg) {
  const problems = [];
  if (!isPlainObject(cfg)) return [{ path: '', code: 'NOT_AN_OBJECT', detail: String(cfg) }];

  for (const s of SECTIONS) {
    if (cfg[s] === undefined) continue;
    if (!isPlainObject(cfg[s])) problems.push({ path: s, code: 'NOT_AN_OBJECT', detail: String(cfg[s]) });
  }
  if (problems.length) return problems;

  const c = mergeConfig(defaultConfig(), cfg);

  // Types are derived from the defaults, so a new key cannot silently skip validation.
  for (const s of SECTIONS) {
    for (const [key, fallback] of Object.entries(DEFAULT_CONFIG[s])) {
      const path = `${s}.${key}`;
      const value = c[s][key];
      if (typeof fallback === 'boolean') {
        if (typeof value !== 'boolean') problems.push({ path, code: 'NOT_A_BOOLEAN', detail: String(value) });
        continue;
      }
      if (typeof fallback === 'string') {
        // Strings are validated by kind, not by range. A NUL byte is refused
        // because it silently truncates any path it reaches.
        if (typeof value !== 'string' || value.trim() === '') {
          problems.push({ path, code: 'NOT_A_NON_EMPTY_STRING', detail: String(value) });
        } else if (value.includes('\u0000')) {
          problems.push({ path, code: 'CONTAINS_NUL', detail: 'a NUL byte is not allowed' });
        }
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push({ path, code: 'NOT_A_FINITE_NUMBER', detail: String(value) });
        continue;
      }
      const range = RANGE[path];
      if (range && (value < range[0] || value > range[1])) {
        problems.push({ path, code: 'OUT_OF_RANGE', detail: `${value} not in [${range[0]}, ${range[1]}]` });
      }
    }
  }
  if (c.matcher.askThreshold > c.matcher.reuseThreshold) {
    problems.push({
      path: 'matcher.askThreshold',
      code: 'THRESHOLD_ORDER',
      detail: `askThreshold (${c.matcher.askThreshold}) must be <= reuseThreshold (${c.matcher.reuseThreshold})`,
    });
  }
  if (c.matcher.labelWeight + c.matcher.embeddingWeight <= 0) {
    problems.push({
      path: 'matcher.labelWeight',
      code: 'ZERO_TOTAL_WEIGHT',
      detail: 'labelWeight + embeddingWeight must be > 0',
    });
  }
  return problems;
}

/** Known sections and keys only; unknown keys are dropped so a stale file cannot inject behaviour. */
export function mergeConfig(base, patch) {
  const out = isPlainObject(base) ? { ...base } : defaultConfig();
  for (const s of SECTIONS) out[s] = { ...(isPlainObject(out[s]) ? out[s] : DEFAULT_CONFIG[s]) };
  if (!isPlainObject(patch)) return out;
  for (const s of SECTIONS) {
    const p = patch[s];
    if (!isPlainObject(p)) continue;
    for (const key of Object.keys(DEFAULT_CONFIG[s])) {
      if (p[key] !== undefined) out[s][key] = p[key];
    }
  }
  return out;
}

/**
 * strict (default) throws on unusable input. strict:false degrades to the
 * all-off defaults, which is the safe direction: the layer simply stays inert.
 */
export function loadConfig(filePath, { strict = true } = {}) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultConfig();
    if (strict) throw err;
    return defaultConfig();
  }
  let parsed;
  try {
    // Strip a UTF-8 BOM before parsing.
    //
    // This is not hypothetical: Windows PowerShell 5.1 writes a BOM by default
    // (`Set-Content -Encoding UTF8`, `Out-File -Encoding utf8`), and `JSON.parse`
    // rejects a leading U+FEFF. Without this the file would fail to parse, the
    // resolver would fall back to all-off defaults, and the plugin would go silent
    // with no error anywhere -- the worst possible failure for a config file a human
    // is expected to hand-edit.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    if (strict) throw new SyntaxError(`invalid JSON in ${filePath}: ${err.message}`);
    return defaultConfig();
  }
  const problems = validateConfig(parsed);
  if (problems.length) {
    if (strict) throw new RangeError(`invalid config in ${filePath}: ${problems.map((p) => `${p.path}:${p.code}`).join(', ')}`);
    return defaultConfig();
  }
  return mergeConfig(defaultConfig(), parsed);
}

export function saveConfig(filePath, cfg) {
  const problems = validateConfig(cfg);
  if (problems.length) {
    throw new RangeError(`refusing to save invalid config: ${problems.map((p) => `${p.path}:${p.code}`).join(', ')}`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(mergeConfig(defaultConfig(), cfg), null, 2)}\n`, 'utf8');
}

export function isEnabled(cfg, switchName) {
  return cfg?.switches?.[switchName] === true;
}
