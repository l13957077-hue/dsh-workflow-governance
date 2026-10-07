#!/usr/bin/env node
/**
 * Phase-2 verification runner.
 *
 *   node verify/run.mjs --trace verify/stage2-trace.json
 *   node verify/run.mjs --trace <path> --json
 *   node verify/run.mjs --probe <any-plugin-json>     # show its shape, bounded
 *
 * Exit codes: 0 = all 10 checks PASS, 1 = at least one FAIL, 2 = usage/IO error.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCore, runPluginClaims, summarize, PASS, FAIL } from './checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Terminal alignment needs display width, not code-point count.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function dw(s) {
  let n = 0;
  for (const ch of String(s)) n += WIDE.test(ch) ? 2 : 1;
  return n;
}
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dw(s)));

function parseArgs(argv) {
  const out = { trace: join(HERE, 'stage2-trace.json'), probe: null, json: false, requirePluginClaims: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--trace') out.trace = argv[++i];
    else if (a === '--probe') out.probe = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--require-plugin-claims') out.requirePluginClaims = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const HELP = `Phase-2 verification, in two sets (see ../LANDING-PLAN.md sections 1 and 2)

  A. CORE (gating)          R1 R2 R4 R5 R6 R8 R13 — verified against the official seam
  B. PLUGIN CLAIMS (report) R11 R14 R15            — the official seam has no saved/nested
                                                     workflow and no resume, so these only
                                                     hold if the third-party plugin provides them

  --trace <path>             trace document to judge (default: verify/stage2-trace.json)
  --probe <path>             print a bounded structural summary of a JSON file, then exit
  --require-plugin-claims    gate on set B as well (use when you accept the third-party plugin)
  --json                     emit the result as JSON instead of a table

Exit: 0 = gating set green, 1 = a gating check failed, 2 = usage/IO error`;

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`cannot read ${path}: ${err.code ?? err.message}`);
    console.error(`\nStart from the template:\n  copy verify/stage2-trace.template.json verify/stage2-trace.json\nThen fill it from one real run (see verify/README.md).`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`invalid JSON in ${path}: ${err.message}`);
    process.exit(2);
  }
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

function shape(v, depth, maxDepth, lines) {
  if (depth > maxDepth) return;
  if (Array.isArray(v)) {
    if (v.length === 0) return;
    lines.push(`${'  '.repeat(depth)}[0] ${typeOf(v[0])}`);
    if (v[0] && typeof v[0] === 'object') shape(v[0], depth + 1, maxDepth, lines);
    return;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    for (const k of keys.slice(0, 40)) {
      const val = v[k];
      lines.push(`${'  '.repeat(depth)}${k}: ${typeOf(val)}`);
      if (val && typeof val === 'object') shape(val, depth + 1, maxDepth, lines);
    }
    if (keys.length > 40) lines.push(`${'  '.repeat(depth)}... (+${keys.length - 40} more keys)`);
  }
}

function probe(path) {
  const doc = readJson(path);
  const lines = [];
  shape(doc, 0, 3, lines);
  console.log(`shape of ${resolve(path)}`);
  console.log(lines.join('\n'));
  console.log('\nThis is read-only reconnaissance: map the real keys into verify/stage2-trace.json.');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.probe) {
  probe(args.probe);
  process.exit(0);
}

const trace = readJson(args.trace);

// A trace with no provenance is not evidence. Refuse to judge it, so an
// illustrative/example document can never be mistaken for a real pass.
const prov = trace?.observedFrom;
const hasProv = prov && typeof prov.command === 'string' && prov.command.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(String(prov.date ?? ''));
if (!hasProv) {
  console.error(`trace has no provenance: ${resolve(args.trace)}`);
  console.error('Set observedFrom.command to the real command you ran and observedFrom.date to YYYY-MM-DD.');
  console.error('Refusing to judge an unattributed trace.');
  process.exit(2);
}
const isExample = /^EXAMPLE/i.test(prov.command);

const core = runCore(trace);
const coreSummary = summarize(core);
const claims = runPluginClaims(trace);
const claimSummary = summarize(claims);

if (args.json) {
  console.log(JSON.stringify({
    trace: resolve(args.trace),
    core: { summary: coreSummary, results: core },
    pluginClaims: { summary: claimSummary, results: claims },
  }, null, 2));
  const ok = coreSummary.allPass && (!args.requirePluginClaims || claimSummary.allPass);
  process.exit(ok ? 0 : 1);
}

const wId = 4;
const wSt = 4;
const allMeasured = [...core, ...claims].map((r) => r.measured);
const wMe = Math.min(Math.max(...allMeasured.map((r) => dw(r.measured))), 58);

function table(rows) {
  console.log(`${pad('ID', wId)}  ${pad('STAT', wSt)}  ${pad('MEASURED', wMe)}  EVIDENCE`);
  console.log(`${'-'.repeat(wId)}  ${'-'.repeat(wSt)}  ${'-'.repeat(wMe)}  ${'-'.repeat(30)}`);
  for (const r of rows) {
    const st = r.status === PASS ? 'PASS' : 'FAIL';
    let me = r.measured;
    if (dw(me) > wMe) me = `${[...me].slice(0, wMe - 1).join('')}…`;
    console.log(`${pad(r.id, wId)}  ${pad(st, wSt)}  ${pad(me, wMe)}  ${r.evidence}`);
  }
}

console.log(`phase-2 verification  trace=${resolve(args.trace)}`);
console.log(`provenance: ${prov.command}  @ ${prov.date}`);
if (isExample) {
  console.log('*** WARNING: this is the shipped EXAMPLE trace. It does NOT verify your host. ***');
}
console.log('');

console.log(`A. ✅ CORE set (verified against the official seam) — ${coreSummary.total} checks, GATING`);
table(core);
console.log('');
console.log(`B. [三方待核验] set (official seam has no saved workflow / no resume) — ${claimSummary.total} checks, REPORT ONLY`);
table(claims);

console.log('');
const failed = [...core, ...claims].filter((x) => x.status === FAIL);
for (const r of failed) {
  console.log(`FAIL ${r.id} — ${r.title}`);
  console.log(`     measured: ${r.measured}`);
  console.log(`     evidence: ${r.evidence}`);
}
if (failed.length) console.log('');

console.log(`CORE   : ${coreSummary.passed}/${coreSummary.total} PASS, ${coreSummary.failed} FAIL`);
console.log(`CLAIMS : ${claimSummary.passed}/${claimSummary.total} PASS, ${claimSummary.failed} FAIL`);

if (isExample) {
  console.log('');
  console.log('EXAMPLE DATA — replace observedFrom.command and every value with your real observations');
  console.log('before treating this as verified.');
  process.exit(1);
}

if (coreSummary.failed > 0) {
  console.log('');
  console.log('Do NOT proceed to phase 3. A failing CORE row means the official seam does NOT cover it:');
  console.log('downgrade it in LANDING-PLAN.md section 1 and move it into the remaining-gap list.');
  process.exit(1);
}

if (claimSummary.failed > 0) {
  console.log('');
  console.log('CORE is green. The failing CLAIMS rows are [三方待核验]: the official seam explicitly has no');
  console.log('saved/nested workflow and does not persist results or topology, so these only hold if the');
  console.log('third-party plugin provides them. Either accept the third-party plugin (re-run with');
  console.log('--require-plugin-claims to gate on it) or move them to the build list (G1 in LANDING-PLAN.md).');
  if (!args.requirePluginClaims) process.exit(0);
  process.exit(1);
}

console.log('');
console.log('All CORE requirements and all plugin claims verified. Proceed to phase 3.');
process.exit(0);
