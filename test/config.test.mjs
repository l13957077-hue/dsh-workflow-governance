import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  defaultConfig,
  mergeConfig,
  validateConfig,
  loadConfig,
  saveConfig,
  isEnabled,
} from '../src/config.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wfg-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a UTF-8 BOM does not silently turn every switch off', () => {
  // PowerShell 5.1 writes a BOM by default and `JSON.parse` rejects a leading
  // U+FEFF, so without this the file would fail to parse and the resolver would
  // silently fall back to all-off -- no error anywhere, just a dead plugin.
  withTempDir((dir) => {
    const file = join(dir, 'config.json');
    writeFileSync(file, `\uFEFF${JSON.stringify({ switches: { deadlockDetector: true } })}`, 'utf8');
    const cfg = loadConfig(file);
    assert.equal(cfg.switches.deadlockDetector, true, 'the file was read, not discarded');
    assert.equal(cfg.switches.contracts, false, 'and only what the file says is on');

    // A BOM in front of broken JSON must still be treated as a broken file.
    writeFileSync(file, '\uFEFF{ not json', 'utf8');
    assert.deepEqual(loadConfig(file, { strict: false }), defaultConfig());
  });
});

test('every switch ships off', () => {
  const cfg = defaultConfig();
  assert.deepEqual(cfg.switches, {
    workflowMode: false,
    deadlockDetector: false,
    semanticMatcher: false,
    capabilityGate: false,
    contracts: false,
    templateLibrary: false,
    resultArtifacts: false,
  });
  for (const name of Object.keys(DEFAULT_CONFIG.switches)) {
    assert.equal(isEnabled(cfg, name), false);
  }
});

test('a frozen default cannot be mutated into a global change', () => {
  assert.throws(() => { DEFAULT_CONFIG.switches.workflowMode = true; }, TypeError);
  const a = defaultConfig();
  a.switches.workflowMode = true;
  assert.equal(defaultConfig().switches.workflowMode, false);
});

test('defaults match the documented thresholds', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.matcher.reuseThreshold, 0.8);
  assert.equal(cfg.matcher.askThreshold, 0.6);
  assert.equal(cfg.deadlock.scanIntervalMs, 30000);
  assert.equal(cfg.deadlock.idleTimeoutMs, 60000);
  assert.equal(cfg.deadlock.escalateAfter, 3);
  assert.equal(cfg.gate.allowOnce, true);
  assert.equal(cfg.contracts.maxAttemptsPerNode, 2);
  assert.equal(cfg.library.root, 'library', 'the store defaults to a plugin-relative path, never a machine-global one');
  assert.equal(cfg.artifacts.root, 'results', 'R11 artifacts are plugin-relative too');
  assert.equal(cfg.artifacts.maxFiles, 50);
});

test('a partial patch merges over defaults without dropping siblings', () => {
  const cfg = mergeConfig(defaultConfig(), { switches: { semanticMatcher: true }, matcher: { askThreshold: 0.7 } });
  assert.equal(cfg.switches.semanticMatcher, true);
  assert.equal(cfg.switches.capabilityGate, false);
  assert.equal(cfg.matcher.askThreshold, 0.7);
  assert.equal(cfg.matcher.reuseThreshold, 0.8);
});

test('unknown keys are dropped so a stale file cannot inject behaviour', () => {
  const cfg = mergeConfig(defaultConfig(), { switches: { backdoor: true }, evil: { exec: 'rm -rf /' } });
  assert.equal(cfg.switches.backdoor, undefined);
  assert.equal(cfg.evil, undefined);
  assert.deepEqual(cfg, defaultConfig());
});

test('invalid values are reported, not silently accepted', () => {
  assert.deepEqual(validateConfig(defaultConfig()), []);
  const cases = [
    [{ switches: { workflowMode: 'yes' } }, 'NOT_A_BOOLEAN'],
    [{ matcher: { reuseThreshold: 1.5 } }, 'OUT_OF_RANGE'],
    [{ matcher: { askThreshold: 0.9, reuseThreshold: 0.5 } }, 'THRESHOLD_ORDER'],
    [{ matcher: { labelWeight: 0, embeddingWeight: 0 } }, 'ZERO_TOTAL_WEIGHT'],
    [{ deadlock: { scanIntervalMs: Number.NaN } }, 'NOT_A_FINITE_NUMBER'],
    [{ gate: { defaultTtlMs: -1 } }, 'OUT_OF_RANGE'],
    [{ contracts: { maxAttemptsPerNode: 0 } }, 'OUT_OF_RANGE'],
    [{ contracts: { maxAttemptsPerNode: 101 } }, 'OUT_OF_RANGE'],
    [{ contracts: { maxAttemptsPerNode: 'two' } }, 'NOT_A_FINITE_NUMBER'],
    [{ library: { root: 42 } }, 'NOT_A_NON_EMPTY_STRING'],
    [{ library: { root: '' } }, 'NOT_A_NON_EMPTY_STRING'],
    [{ library: { root: '   ' } }, 'NOT_A_NON_EMPTY_STRING'],
    [{ library: { root: 'a\u0000b' } }, 'CONTAINS_NUL'],
    [{ artifacts: { maxFiles: 20_001 } }, 'OUT_OF_RANGE'],
    [{ artifacts: { maxFiles: -1 } }, 'OUT_OF_RANGE'],
  ];
  for (const [patch, code] of cases) {
    const problems = validateConfig(mergeConfig(defaultConfig(), patch));
    assert.ok(problems.some((p) => p.code === code), `expected ${code}, got ${JSON.stringify(problems)}`);
  }
});

test('non-object config is rejected rather than defaulted', () => {
  assert.equal(validateConfig(null)[0].code, 'NOT_AN_OBJECT');
  assert.equal(validateConfig('nope')[0].code, 'NOT_AN_OBJECT');
});

test('save then load round-trips a validated config', () =>
  withTempDir((dir) => {
    const file = join(dir, 'nested', 'workflow-governance.json');
    const cfg = mergeConfig(defaultConfig(), { switches: { deadlockDetector: true }, gate: { allowOnce: false } });
    saveConfig(file, cfg);
    assert.deepEqual(loadConfig(file), cfg);
  }));

test('saving an invalid config is refused', () =>
  withTempDir((dir) => {
    const file = join(dir, 'bad.json');
    const cfg = mergeConfig(defaultConfig(), { matcher: { askThreshold: 0.99, reuseThreshold: 0.1 } });
    assert.throws(() => saveConfig(file, cfg), RangeError);
  }));

test('a missing config file loads as all-off defaults', () =>
  withTempDir((dir) => {
    assert.deepEqual(loadConfig(join(dir, 'absent.json')), defaultConfig());
  }));

test('a corrupt config throws in strict mode and degrades to all-off otherwise', () =>
  withTempDir((dir) => {
    const file = join(dir, 'corrupt.json');
    writeFileSync(file, '{ this is not json', 'utf8');
    assert.throws(() => loadConfig(file), SyntaxError);
    assert.deepEqual(loadConfig(file, { strict: false }), defaultConfig());
  }));

test('a stored invalid config cannot silently enable a feature', () =>
  withTempDir((dir) => {
    const file = join(dir, 'sneaky.json');
    writeFileSync(file, JSON.stringify({ switches: { workflowMode: 'true' } }), 'utf8');
    assert.throws(() => loadConfig(file), RangeError);
    const degraded = loadConfig(file, { strict: false });
    assert.equal(isEnabled(degraded, 'workflowMode'), false);
  }));
